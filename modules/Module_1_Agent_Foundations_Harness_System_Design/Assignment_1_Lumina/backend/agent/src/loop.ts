import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool
} from 'openai/resources/chat/completions';
import {
  newId,
  type AskMode,
  type Depth,
  type DoneEvent,
  type Source,
  type Terminated,
  type ToolName
} from '@lumina/contract';
import { env, secrets } from './env.js';
import type { Sse } from './sse.js';
import { ProviderError, type SearchResult } from './tools/search.js';
import { cachedSearch } from './cache.js';
import type { Turn } from './threads.js';
import { recallMemory, saveMemory } from './memory.js';
import { fetchPage, type FetchedPage } from './tools/fetch.js';
import { searchDocuments, spaceContents, type DocHit } from './tools/documents.js';
import type { RunState, ToolCallRecord } from './runlog.js';

/**
 * The QUICK loop. Three phases:
 *
 *   recall    the harness runs recall_memory first, every time: "what do I already know
 *             about this user" must always happen, so it is not left to the model.
 *   research  think → call a tool → observe → repeat, until the model stops asking for
 *             tools (done) or a cap is hit (cap). Every tool call is a `trace` event.
 *   answer    number what was actually fetched, send `sources`, THEN stream the answer
 *             as `token`s, then `done`.
 *
 * Fail loud: an LLM, embedding or search-provider exception is not caught here. It
 * propagates to the route, which turns it into a 502. A page that will not load is
 * different — that is one failed tool step (ok:false + error) and the loop carries on.
 *
 * Quick search is offered web_search, fetch_page and save_memory, plus search_documents
 * when the request names a Space (mode auto or docs). mode docs offers ONLY
 * search_documents and forces it on the first turn. plan_research is not in the tool list
 * at all, so no prompt, however persuasive, can make a quick run escalate.
 */

export interface AskContext {
  query: string;
  history: Turn[];
  userId: string;
  threadId: string;
  mode: AskMode;
  /** Already checked to belong to userId by the route. */
  spaceId?: string;
}

export type SpaceContents = Awaited<ReturnType<typeof spaceContents>>;

/** What this request may search, decided once from `mode` and whether a Space was given. */
export interface Route {
  tools: 'web' | 'docs' | 'both';
  space?: SpaceContents;
}

/**
 * One piece of retrieved evidence, in the order it arrived. Sources are numbered from this.
 * On a deep search each piece also says which sub-question found it.
 */
export type Evidence = ({ kind: 'web'; page: FetchedPage } | { kind: 'doc'; hit: DocHit }) & { subQuestion?: number };

export interface AnswerResult {
  answerId: string;
  terminated: Terminated;
  searchCached: boolean;
  toolCalls: ToolCallRecord[];
  tokens: { in: number; out: number };
  costUsd: number;
  ttftMs: number;
  latencyMs: number;
  /** What gets saved to the thread: the text exactly as streamed, its sources, its done. */
  content: string;
  sources: Source[];
  done: DoneEvent;
}

const SEARCH_DOCUMENTS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'search_documents',
    description:
      "Search the user's uploaded documents in this Space (hybrid: meaning + exact words). " +
      'Returns the best-matching passages with their file and page or heading.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "A focused query, using the words the document itself would use." },
        reason: { type: 'string', description: 'One short sentence: why the documents (this is the routing decision).' }
      },
      required: ['query', 'reason'],
      additionalProperties: false
    }
  }
};

const QUICK_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns titles, URLs and short snippets — snippets are for choosing pages, not for answering.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A focused search query.' },
          reason: { type: 'string', description: 'One short sentence: why this search.' }
        },
        required: ['query', 'reason'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: 'Download a page from the search results and read its full article text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A URL from the search results.' },
          reason: { type: 'string', description: 'One short sentence: why this page.' }
        },
        required: ['url', 'reason'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Remember a STABLE fact or preference the user stated about THEMSELVES, for all future conversations ' +
        '(e.g. "Prefers TypeScript code examples", "Is vegetarian", "Wants answers in Spanish"). ' +
        'Never save facts about the world, anything from search results, or temporary states ("tired today").',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, in one short third-person sentence.' },
          reason: { type: 'string', description: 'One short sentence: why this is worth remembering.' }
        },
        required: ['text', 'reason'],
        additionalProperties: false
      }
    }
  }
];

const WEB_ROUTE =
  'Call web_search with a focused query, then fetch_page on the 2-4 most relevant results (prefer primary and reputable sources; fetch several in one turn when you can).';

/**
 * Where to look. `docs` and `web` are the user's decision; `auto` is the model's, made from
 * the question and the Space's file list, and its reason lands in the trace.
 */
function routeInstructions(route: Route): string {
  const files = route.space ? spaceList(route.space) : '';
  if (route.tools === 'web') return WEB_ROUTE;
  if (route.tools === 'docs') {
    return (
      `Answer from the user's documents only. Call search_documents with a focused query.${files}\n` +
      'If the passages do not cover the question, search once more with different wording (the terms the document would use). Never use the web.'
    );
  }
  return (
    `Decide where the answer lives.${files}\n` +
    '- About the content of these documents, or the user\'s own material ("we", "our", "the report"): call search_documents.\n' +
    '- Current events, prices, or general knowledge the documents would not hold: ' + WEB_ROUTE + '\n' +
    '- If the question needs both (e.g. "what did we commit to, and what does the market say?"), do both.\n' +
    "Every tool call's reason states this routing decision in a few words."
  );
}

function spaceList(space: SpaceContents): string {
  const ready = space.indexed.length ? `\nThe user's Space holds: ${space.indexed.join(', ')}.` : "\nThe user's Space has no indexed documents yet.";
  const waiting = space.notReady.length ? ` Still being indexed (not searchable yet): ${space.notReady.join(', ')}.` : '';
  return ready + waiting;
}

const RESEARCH_PROMPT = (maxCalls: number, known: string, route: Route) => `You are the research step of LUMINA, an answer engine. Gather evidence; do not answer.
${routeInstructions(route)}
Earlier turns of the conversation may come first: resolve words like "it" or "that" from them and search for the full topic, not the literal follow-up words.
If the user states a lasting fact or preference about themselves, call save_memory once for it. If the message only tells you something about the user and asks nothing, save it and reply DONE without searching.
Search again only if the first results are off-topic. Stop calling tools as soon as the evidence covers the question, and reply with the single word DONE.
Every tool call needs a one-sentence reason. Hard limit: ${maxCalls} tool calls in total.${known}`;

export const ANSWER_PROMPT = (o: {
  sourceCount: number;
  terminated: Terminated;
  known: string;
  saved: string[];
  searched: boolean;
}) =>
  [
    'You are LUMINA, an answer engine. Answer the question using ONLY the numbered sources provided.',
    'Cite every factual claim with [n], where n is a source number. Cite several sources as [1][2], never [1, 2].',
    'Never cite a number that is not in the list and never mention a source or URL that is not in the list.',
    'Be concise: a direct answer first, then brief supporting detail. If the sources do not answer the question, say so plainly.',
    o.saved.length
      ? `You just saved this to the user's long-term memory: ${o.saved.map((s) => `"${s}"`).join('; ')}. Confirm that briefly.`
      : '',
    o.sourceCount === 0 && o.saved.length && !o.searched
      ? 'The user only told you something about themselves; there was nothing to research. Do not cite anything.'
      : o.sourceCount === 0
        ? 'NO sources were retrieved for this question. Say that you could not find sources to answer it. Do not cite anything and do not answer from memory.'
        : '',
    o.terminated === 'cap'
      ? 'Research was cut short by the tool-call or time limit. Say briefly that this answer is partial.'
      : '',
    o.known
  ]
    .filter(Boolean)
    .join('\n');

/**
 * What the user's saved memories look like to the model. They are instructions about the
 * user, never evidence: an answer that cited "you told me you like TypeScript" as [3]
 * would be a citation to something that was not retrieved from the web or a document.
 */
export function knownAboutUser(memories: string[]): string {
  if (!memories.length) return '';
  return (
    '\n\nSaved facts and preferences about this user (follow them; they are NOT sources, never cite them):\n' +
    memories.map((m) => `- ${m}`).join('\n')
  );
}

/** How much of each page the answer step reads. More is cost, not grounding. */
const PAGE_CHARS_FOR_ANSWER = 5_000;

let client: OpenAI | null = null;
export function llm(): OpenAI {
  if (env.llmProvider !== 'openai') {
    throw new ProviderError('llm', `LLM_PROVIDER=${env.llmProvider} is not wired up; this agent speaks OpenAI`);
  }
  if (!secrets.openai) throw new ProviderError('openai', 'OPENAI_API_KEY is not set');
  client ??= new OpenAI({ apiKey: secrets.openai });
  return client;
}

/**
 * `run` is owned by the caller, so that the tally (tool calls, tokens, cost) survives this
 * function throwing and still reaches the run log.
 */
export async function runQuickAnswer(ctx: AskContext, sse: Sse, run: RunState): Promise<AnswerResult> {
  const { query, history } = ctx;
  const deadline = run.started + env.maxWallClockSec * 1000;
  const { toolCalls } = run;
  const addUsage = (u?: { prompt_tokens?: number; completion_tokens?: number } | null) => run.addUsage(u);

  const evidence: Evidence[] = [];
  const saved: string[] = [];
  let retrieved = false;
  let terminated: Terminated = 'done';

  // The Space's file list is what `auto` routes on; fetch it while memory is recalled.
  const spaceLookup = ctx.spaceId ? spaceContents(ctx.spaceId, ctx.userId) : Promise.resolve(undefined);

  // ------------------------------------------------------------- recall: always, by the harness
  const known = knownAboutUser(await recallStep(ctx, sse, run));

  // ------------------------------------------------------------- route: which tools, from mode
  const route = routeFor(ctx, await spaceLookup);
  const tools = toolsFor(route.tools);

  // ------------------------------------------------------------- research: the loop
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: RESEARCH_PROMPT(env.maxToolCalls, known, route) },
    ...history,
    { role: 'user', content: query }
  ];

  for (let turn = 1; ; turn++) {
    if (Date.now() >= deadline) {
      terminated = 'cap';
      break;
    }
    const completion = await llm().chat.completions.create({
      model: env.llmModel,
      messages,
      tools,
      // mode docs is the user saying "answer from my documents": the first move is not the
      // model's to skip. After that it may search again or stop.
      tool_choice:
        route.tools === 'docs' && turn === 1
          ? { type: 'function', function: { name: 'search_documents' } }
          : 'auto',
      temperature: 0
    });
    addUsage(completion.usage);
    const msg = completion.choices[0]?.message;
    const requested = msg?.tool_calls ?? [];
    if (!msg || requested.length === 0) break; // the model has what it needs: done

    const room = env.maxToolCalls - toolCalls.length;
    if (room <= 0) {
      terminated = 'cap';
      break;
    }
    const batch = requested.slice(0, room);
    const outcomes = await Promise.allSettled(batch.map((call) => runTool(call, ctx, tools)));

    messages.push(msg);
    for (const [i, call] of batch.entries()) {
      const outcome = outcomes[i]!;
      const step = toolCalls.length + 1;
      const name = call.function.name as ToolName;

      if (outcome.status === 'rejected') {
        // A provider failure (search or embeddings). Make it visible, then fail loud: the
        // route turns this into a 502. Never "no results".
        const error = errorMessage(outcome.reason);
        toolCalls.push({ name, ok: false, error, ms: 0 });
        sse.send('trace', { step, tool: name, input: safeArgs(call).input, ok: false, ms: 0, error });
        throw outcome.reason;
      }

      const r = outcome.value;
      toolCalls.push({ name, ok: r.ok, error: r.error, ms: r.ms });
      sse.send('trace', { step, tool: name, input: r.input, ok: r.ok, ms: r.ms, reason: r.reason, error: r.error });
      if (r.searched) run.searches += 1;
      if (r.cached) run.cacheHits += 1;
      if (r.saved) saved.push(r.saved);
      if (r.searched || r.hits) retrieved = true;
      run.embeddingTokens += r.embeddingTokens ?? 0;
      const page = r.page;
      if (page && !evidence.some((e) => e.kind === 'web' && e.page.url === page.url)) {
        evidence.push({ kind: 'web', page });
      }
      for (const hit of r.hits ?? []) {
        if (!evidence.some((e) => e.kind === 'doc' && e.hit.chunkId === hit.chunkId)) evidence.push({ kind: 'doc', hit });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: r.forModel });
    }

    if (batch.length < requested.length) {
      terminated = 'cap';
      break;
    }
  }

  // ------------------------------------------------------------- answer: sources, then tokens
  return streamAnswer({
    sse,
    run,
    query,
    history,
    evidence,
    terminated,
    depth: 'quick',
    subQuestions: 0,
    pageChars: PAGE_CHARS_FOR_ANSWER,
    system: ANSWER_PROMPT({ sourceCount: evidence.length, terminated, known, saved, searched: retrieved })
  });
}

// ---------------------------------------------------------------- shared by quick and deep

/** recall_memory, run by the harness as step 1 of every answer. Returns the recalled facts. */
export async function recallStep(ctx: AskContext, sse: Sse, run: RunState): Promise<string[]> {
  const t0 = Date.now();
  const input = { query: ctx.query };
  try {
    const r = await recallMemory(ctx.userId, ctx.query);
    run.embeddingTokens += r.tokens;
    const recalled = r.memories.map((m) => m.text);
    const ms = Date.now() - t0;
    run.toolCalls.push({ name: 'recall_memory', ok: true, ms });
    sse.send('trace', {
      step: run.toolCalls.length,
      tool: 'recall_memory',
      input,
      ok: true,
      ms,
      reason: recalled.length
        ? `recalled ${recalled.length}: ${recalled.join(' | ').slice(0, 300)}`
        : 'no saved memories for this user match'
    });
    return recalled;
  } catch (err) {
    const error = errorMessage(err);
    run.toolCalls.push({ name: 'recall_memory', ok: false, error, ms: Date.now() - t0 });
    sse.send('trace', { step: run.toolCalls.length, tool: 'recall_memory', input, ok: false, ms: Date.now() - t0, error });
    throw err;
  }
}

export function routeFor(ctx: AskContext, space: SpaceContents | undefined): Route {
  return { tools: ctx.mode === 'docs' ? 'docs' : ctx.mode === 'auto' && ctx.spaceId ? 'both' : 'web', space };
}

/**
 * The end of every answer: number the evidence, send `sources`, THEN stream the answer as
 * `token`s with unknown [n] dropped, then `done`.
 */
export async function streamAnswer(o: {
  sse: Sse;
  run: RunState;
  query: string;
  history: Turn[];
  evidence: Evidence[];
  terminated: Terminated;
  depth: Depth;
  subQuestions: number;
  pageChars: number;
  system: string;
}): Promise<AnswerResult> {
  const { sse, run, query, evidence, terminated } = o;

  // Numbered in the order given, so a document search's best passage is its lowest [n].
  const sources: Source[] = evidence.map((e, i): Source => {
    const tag = e.subQuestion ? { subQuestion: e.subQuestion } : {};
    return e.kind === 'web'
      ? { n: i + 1, kind: 'web', title: e.page.title, url: e.page.url, snippet: pickSnippet(e.page.text, query), ...tag }
      : {
          n: i + 1,
          kind: 'doc',
          title: e.hit.title,
          docId: e.hit.docId as Source['docId'],
          locator: e.hit.locator,
          // The whole chunk: it IS the retrieved passage, verbatim, so it is what grounds the claim.
          snippet: e.hit.text,
          ...tag
        };
  });
  sse.send('sources', sources);

  const context = evidence
    .map((e, i) =>
      e.kind === 'web'
        ? `[${i + 1}] ${e.page.title}\n${e.page.url}\n${e.page.text.slice(0, o.pageChars)}`
        : `[${i + 1}] ${e.hit.title}, ${locatorLabel(e.hit.locator)}\n${e.hit.text}`
    )
    .join('\n\n');

  const stream = await llm().chat.completions.create({
    model: env.llmModel,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    messages: [
      { role: 'system', content: o.system },
      ...o.history,
      { role: 'user', content: `Question: ${query}\n\nSources:\n${context || '(none)'}` }
    ]
  });

  let ttftMs: number | null = null;
  let content = '';
  const emit = (text: string) => {
    if (!text) return;
    ttftMs ??= Date.now() - run.started;
    content += text;
    sse.send('token', { text });
  };
  const citations = new CitationFilter(sources.length);
  for await (const chunk of stream) {
    if (chunk.usage) run.addUsage(chunk.usage);
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) emit(citations.push(delta));
  }
  emit(citations.flush());

  const latencyMs = Date.now() - run.started;
  const costUsd = run.costUsd();
  const answerId = newId('ans');
  // true only when EVERY search in the request was a hit. A request that made no search
  // at all has nothing cached to report, so it is false.
  const searchCached = run.searches > 0 && run.cacheHits === run.searches;

  const done: DoneEvent = {
    answerId,
    latencyMs,
    ttftMs: ttftMs ?? latencyMs,
    model: env.llmModel,
    tokens: run.tokens,
    costUsd,
    searchCached,
    terminated,
    depth: o.depth,
    subQuestions: o.subQuestions
  };
  sse.send('done', done);

  return {
    answerId,
    terminated,
    searchCached,
    toolCalls: run.toolCalls,
    tokens: run.tokens,
    costUsd,
    ttftMs: done.ttftMs,
    latencyMs,
    content,
    sources,
    done
  };
}

// ---------------------------------------------------------------- tools

interface ToolOutcome {
  ok: boolean;
  error?: string;
  ms: number;
  input: Record<string, unknown>;
  reason?: string;
  forModel: string;
  searched?: boolean;
  cached?: boolean;
  saved?: string;
  embeddingTokens?: number;
  page?: FetchedPage;
  /** search_documents' passages, best first. Present (possibly empty) whenever it ran. */
  hits?: DocHit[];
}

function toolsFor(route: Route['tools']): ChatCompletionTool[] {
  if (route === 'web') return QUICK_TOOLS;
  const saveMemoryTool = QUICK_TOOLS.filter((t) => t.function.name === 'save_memory');
  return route === 'docs' ? [SEARCH_DOCUMENTS_TOOL, ...saveMemoryTool] : [SEARCH_DOCUMENTS_TOOL, ...QUICK_TOOLS];
}

/** `p. 14`, `§ Pricing`, `line 40`: how a document citation says where it is. */
export function locatorLabel(l: DocHit['locator']): string {
  if (l.page !== undefined) return `p. ${l.page}`;
  if (l.heading !== undefined) return `§ ${l.heading}`;
  return `line ${l.line}`;
}

/**
 * Runs one tool call. Provider errors (search, embeddings) are NOT caught (fail loud); a
 * page that will not load is caught and reported as a failed step, because the loop can
 * carry on without it.
 */
async function runTool(
  call: ChatCompletionMessageToolCall,
  ctx: AskContext,
  offered: ChatCompletionTool[]
): Promise<ToolOutcome> {
  const t0 = Date.now();
  const { input, reason, bad } = safeArgs(call);
  if (bad) return { ok: false, error: bad, ms: 0, input, reason, forModel: `Error: ${bad}` };
  // A model can name a tool it was not given. The route decided; the harness enforces it.
  if (!offered.some((t) => t.function.name === call.function.name)) {
    const error = `tool ${call.function.name} is not available for mode ${ctx.mode}`;
    return { ok: false, error, ms: 0, input, reason, forModel: `Error: ${error}` };
  }

  if (call.function.name === 'search_documents') {
    if (!ctx.spaceId) {
      const error = 'search_documents needs a spaceId on the request';
      return { ok: false, error, ms: 0, input, reason, forModel: `Error: ${error}` };
    }
    // Embedding or Atlas failures throw: an empty list here must mean "nothing matched",
    // never "the search broke".
    const { hits, embeddingTokens } = await searchDocuments(ctx.spaceId, ctx.userId, String(input.query ?? ''));
    return {
      ok: true,
      ms: Date.now() - t0,
      input,
      reason,
      hits,
      embeddingTokens,
      forModel: hits.length
        ? hits
            .map((h, i) => `${i + 1}. ${h.title}, ${locatorLabel(h.locator)} (similarity ${h.similarity})\n   ${h.text.slice(0, 500)}`)
            .join('\n')
        : 'No passage in this Space matches. Try one different wording, or stop and reply DONE.'
    };
  }

  if (call.function.name === 'web_search') {
    const { results, cached } = await cachedSearch(String(input.query));
    return {
      ok: true,
      ms: Date.now() - t0,
      input,
      reason,
      searched: true,
      cached,
      forModel: results.length
        ? formatResults(results)
        : '0 results. Try one different query, or stop and reply DONE.'
    };
  }

  if (call.function.name === 'fetch_page') {
    try {
      const page = await fetchPage(String(input.url));
      return {
        ok: true,
        ms: Date.now() - t0,
        input,
        reason,
        page,
        forModel: `Fetched "${page.title}" (${page.text.length} chars). Opening:\n${page.text.slice(0, 600)}`
      };
    } catch (err) {
      const error = errorMessage(err);
      return { ok: false, error, ms: Date.now() - t0, input, reason, forModel: `Could not read this page: ${error}` };
    }
  }

  if (call.function.name === 'save_memory') {
    const text = String(input.text ?? '').trim();
    if (!text) return { ok: false, error: 'save_memory needs non-empty text', ms: 0, input, reason, forModel: 'Error: empty text' };
    const r = await saveMemory(ctx.userId, text, ctx.threadId);
    return {
      ok: true,
      ms: Date.now() - t0,
      input,
      reason,
      saved: text,
      embeddingTokens: r.tokens,
      forModel: r.duplicate ? 'Already remembered.' : 'Saved.'
    };
  }

  const error = `tool ${call.function.name} is not implemented`;
  return { ok: false, error, ms: 0, input, reason, forModel: `Error: ${error}` };
}

function safeArgs(call: ChatCompletionMessageToolCall): {
  input: Record<string, unknown>;
  reason?: string;
  bad?: string;
} {
  try {
    const { reason, ...input } = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    return { input, reason: typeof reason === 'string' ? reason : undefined };
  } catch {
    return { input: {}, bad: 'the model sent arguments that are not valid JSON' };
  }
}

export function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 300)}`)
    .join('\n');
}

// ---------------------------------------------------------------- grounding helpers

/**
 * The snippet is the passage a citation rests on, and the bench looks for it in the real
 * page. So it is always a VERBATIM slice of the fetched text — never a model's paraphrase —
 * chosen as the paragraph that shares the most words with the question.
 */
export function pickSnippet(text: string, query: string): string {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const terms = new Set(words(query));
  const paragraphs = text.split('\n').filter((p) => p.split(' ').length >= 15);
  let best = paragraphs[0] ?? text;
  let bestScore = -1;
  for (const p of paragraphs) {
    const score = words(p).filter((w) => terms.has(w)).length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  if (best.length <= 400) return best;
  const cut = best.slice(0, 400);
  return cut.slice(0, cut.lastIndexOf(' ') > 200 ? cut.lastIndexOf(' ') : 400);
}

/**
 * Drops any [n] that does not match a source, as the text streams. Tokens split a citation
 * across chunks ("[", "1", "]"), so a possible citation is held back until it closes.
 */
class CitationFilter {
  private held = '';

  constructor(private readonly sourceCount: number) {}

  push(text: string): string {
    let out = '';
    for (const ch of text) {
      if (this.held) {
        this.held += ch;
        if (ch === ']') {
          out += this.resolve(this.held);
          this.held = '';
        } else if (!/^\[\d{0,3}$/.test(this.held)) {
          out += this.held;
          this.held = '';
        }
      } else if (ch === '[') {
        this.held = '[';
      } else {
        out += ch;
      }
    }
    return out;
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }

  private resolve(tag: string): string {
    const m = /^\[(\d{1,3})\]$/.exec(tag);
    if (!m) return tag;
    const n = Number(m[1]);
    return n >= 1 && n <= this.sourceCount ? tag : '';
  }
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim() || 'unknown error';
}
