import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SubQuestion, Terminated, ToolName } from '@lumina/contract';
import { env } from './env.js';
import type { Sse } from './sse.js';
import { cachedSearch } from './cache.js';
import { fetchPage } from './tools/fetch.js';
import { searchDocuments, spaceContents } from './tools/documents.js';
import type { RunState } from './runlog.js';
import {
  ANSWER_PROMPT,
  errorMessage,
  knownAboutUser,
  llm,
  recallStep,
  routeFor,
  streamAnswer,
  type AnswerResult,
  type AskContext,
  type Evidence,
  type Route
} from './loop.js';

/**
 * DEEP search: plan, then execute (Module 2's Plan-and-Execute).
 *
 *   plan     ONE model call (plan_research) splits the question into 3–6 sub-questions,
 *            each with a reason and a search query. The `plan` event streams BEFORE any
 *            retrieval: it is deep's first paint, and a plan shown after the fetches would
 *            be a story told about them, not a plan.
 *   execute  plain code, no model call per sub-question: each sub-question searches, then
 *            reads its best unclaimed pages, all in parallel. Every trace step carries the
 *            sub-question it served. Fixed shape = predictable cost, a budget that holds.
 *   merge    one numbering across all sub-questions, deduplicated (URL, or docId +
 *            locator), in plan order; each source keeps the sub-question that found it.
 *   answer   one structured answer: direct answer, a section per sub-question, bottom line.
 *
 * The trade-off: a sub-question cannot notice its results are poor and search again. With
 * several sub-questions the others cover a weak one, and the cost stays bounded.
 *
 * Budget: env.maxToolCallsDeep counts EVERY step (recall + plan + fan-out), split evenly
 * across the sub-questions before any of them runs, so parallel work cannot overspend it.
 */

interface PlannedSubQuestion extends SubQuestion {
  query: string;
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'One sentence: why this decomposition.' },
    subQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One sub-question, one sentence.' },
          reason: { type: 'string', description: 'Why the answer needs it, in a few words.' },
          query: { type: 'string', description: 'A focused search query for it.' }
        },
        required: ['question', 'reason', 'query'],
        additionalProperties: false
      }
    }
  },
  required: ['reason', 'subQuestions'],
  additionalProperties: false
} as const;

// Terse on purpose: the plan's length IS its latency (every word is generated before the
// user sees anything), and the plan must land within deep_plan_p95_ms.
const PLAN_PROMPT = (min: number, max: number) => `You are the planning step of LUMINA's deep search. Do not answer the question.
Break the user's question into ${min} to ${max} sub-questions that together answer it fully. Use the fewest that cover it.
Each must be answerable by one search and cover ground NO other sub-question covers; order them as a reader needs them.
Never plan a step that only combines, totals or summarises the others: the answer step does that. Every sub-question must go and find something new.
Be terse: each question at most 15 words, each reason at most 8 words, each search query at most 8 words, the overall reason at most 15 words.
Resolve words like "it" or "that" from earlier turns.`;

const DEEP_STRUCTURE = (subs: SubQuestion[]) =>
  [
    'This is a DEEP research answer. The sources were gathered for these sub-questions:',
    ...subs.map((s) => `${s.i}. ${s.question}`),
    'Structure: start with a 2–3 sentence direct answer. Then one short section per sub-question, each under a "### " heading that names it in a few words. End with a "### Bottom line".',
    'Cite every factual claim [n], in every section.'
  ].join('\n');

export async function runDeepAnswer(
  ctx: AskContext,
  sse: Sse,
  run: RunState
): Promise<AnswerResult & { subQuestions: SubQuestion[] }> {
  const deadline = run.started + env.maxWallClockSecDeep * 1000;
  let terminated: Terminated = 'done';

  // ------------------------------------------------------------- recall ‖ plan
  // Memory is not retrieval and the planner does not need it, so they run side by side:
  // every millisecond before the plan is time the user stares at an empty screen.
  const spaceLookup = ctx.spaceId ? spaceContents(ctx.spaceId, ctx.userId) : Promise.resolve(undefined);
  const [recalled, planned] = await Promise.all([recallStep(ctx, sse, run), plan(ctx, sse, run)]);
  const known = knownAboutUser(recalled);
  const subQuestions: SubQuestion[] = planned.map(({ i, question, reason }) => ({ i, question, reason }));
  const route = routeFor(ctx, await spaceLookup);

  // ------------------------------------------------------------- execute: fan out
  const perSub = Math.max(1, Math.floor((env.maxToolCallsDeep - run.toolCalls.length) / planned.length));
  const claimed = new Set<string>(); // pages one sub-question has taken, so another reads something new
  const found = await Promise.all(
    planned.map((s) =>
      research(s, route, perSub, claimed, deadline, ctx, sse, run).then((r) => {
        if (r.capped) terminated = 'cap';
        return r.evidence;
      })
    )
  );

  // ------------------------------------------------------------- merge: one numbering
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const e of found.flat()) {
    const key = e.kind === 'web' ? e.page.url : `${e.hit.docId}:${JSON.stringify(e.hit.locator)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(e);
  }

  // ------------------------------------------------------------- answer
  const result = await streamAnswer({
    sse,
    run,
    query: ctx.query,
    history: ctx.history,
    evidence,
    terminated,
    depth: 'deep',
    subQuestions: subQuestions.length,
    pageChars: env.deepPageChars,
    system: [
      ANSWER_PROMPT({ sourceCount: evidence.length, terminated, known, saved: [], searched: true }),
      DEEP_STRUCTURE(subQuestions)
    ].join('\n')
  });
  return { ...result, subQuestions };
}

// ---------------------------------------------------------------- plan

async function plan(ctx: AskContext, sse: Sse, run: RunState): Promise<PlannedSubQuestion[]> {
  const t0 = Date.now();
  const input = { query: ctx.query };
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: PLAN_PROMPT(env.deepSubQuestionsMin, env.deepSubQuestionsMax) },
    ...ctx.history,
    { role: 'user', content: ctx.query }
  ];
  let parsed: { reason: string; subQuestions: { question: string; reason: string; query: string }[] };
  try {
    // One retry if the model plans too few: a two-part "plan" is a quick search with extra steps.
    for (let attempt = 1; ; attempt++) {
      const completion = await llm().chat.completions.create({
        model: env.llmModel,
        messages,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: PLAN_SCHEMA } }
      });
      run.addUsage(completion.usage);
      parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
      const n = parsed.subQuestions?.length ?? 0;
      if (n >= env.deepSubQuestionsMin || attempt === 2) break;
      messages.push(
        { role: 'assistant', content: completion.choices[0]?.message?.content ?? '' },
        { role: 'user', content: `That is ${n}. Give between ${env.deepSubQuestionsMin} and ${env.deepSubQuestionsMax}.` }
      );
    }
    if (!parsed.subQuestions?.length) throw new Error('the planner returned no sub-questions');
  } catch (err) {
    const error = errorMessage(err);
    run.toolCalls.push({ name: 'plan_research', ok: false, error, ms: Date.now() - t0 });
    sse.send('trace', { step: run.toolCalls.length, tool: 'plan_research', input, ok: false, ms: Date.now() - t0, error });
    throw err;
  }

  const planned = parsed.subQuestions.slice(0, env.deepSubQuestionsMax).map((s, idx) => ({
    i: idx + 1,
    question: s.question.trim(),
    reason: s.reason.trim(),
    query: s.query.trim() || s.question.trim()
  }));
  const ms = Date.now() - t0;
  run.toolCalls.push({ name: 'plan_research', ok: true, ms });
  sse.send('trace', {
    step: run.toolCalls.length,
    tool: 'plan_research',
    input,
    ok: true,
    ms,
    reason: `${planned.length} sub-questions: ${parsed.reason}`
  });
  sse.send('plan', {
    subQuestions: planned.map(({ i, question, reason }) => ({ i, question, reason })),
    reason: parsed.reason
  });
  return planned;
}

// ---------------------------------------------------------------- execute one sub-question

async function research(
  s: PlannedSubQuestion,
  route: Route,
  budget: number,
  claimed: Set<string>,
  deadline: number,
  ctx: AskContext,
  sse: Sse,
  run: RunState
): Promise<{ evidence: Evidence[]; capped: boolean }> {
  const evidence: Evidence[] = [];
  let used = 0;
  let capped = false;

  /** Records one step in the run and the trace, tagged with this sub-question. */
  const step = (name: ToolName, input: Record<string, unknown>, ms: number, ok: boolean, reason?: string, error?: string) => {
    used += 1;
    run.toolCalls.push({ name, ok, error, ms });
    sse.send('trace', { step: run.toolCalls.length, tool: name, input, ok, ms, reason, error, subQuestion: s.i });
  };
  const room = () => {
    if (used >= budget || Date.now() >= deadline) {
      capped = true;
      return false;
    }
    return true;
  };
  /** A provider failure is visible in the trace, then fails the request loud (502). */
  const failLoud = (name: ToolName, input: Record<string, unknown>, t0: number, err: unknown): never => {
    step(name, input, Date.now() - t0, false, undefined, errorMessage(err));
    throw err;
  };

  if (route.tools !== 'web' && ctx.spaceId && room()) {
    const input = { query: s.query };
    const t0 = Date.now();
    const r = await searchDocuments(ctx.spaceId, ctx.userId, s.query).catch((err) => failLoud('search_documents', input, t0, err));
    run.embeddingTokens += r.embeddingTokens;
    step('search_documents', input, Date.now() - t0, true, `${s.reason} — ${r.hits.length} passage(s)`);
    for (const hit of r.hits) evidence.push({ kind: 'doc', hit, subQuestion: s.i });
  }

  if (route.tools !== 'docs' && room()) {
    const input = { query: s.query };
    const t0 = Date.now();
    const { results, cached } = await cachedSearch(s.query).catch((err) => failLoud('web_search', input, t0, err));
    run.searches += 1;
    if (cached) run.cacheHits += 1;
    step('web_search', input, Date.now() - t0, true, `${s.reason} — ${results.length} result(s)${cached ? ' (cached)' : ''}`);

    // The best results no other sub-question has taken. Claimed synchronously, before the
    // fetches start, so two parallel sub-questions never read the same page twice. How many
    // is planned, not cut: this sub-question's share of the budget was fixed before it ran,
    // so a 5- or 6-part plan reads fewer pages each by design. Only the clock is a cap here.
    const wanted = Math.min(env.deepFetchesPerSubQuestion, Math.max(0, budget - used));
    if (Date.now() >= deadline) capped = true;
    const picks: string[] = [];
    for (const r of results) {
      if (capped || picks.length >= wanted) break;
      if (claimed.has(r.url)) continue;
      claimed.add(r.url);
      picks.push(r.url);
    }

    const pages = await Promise.all(
      picks.map(async (url) => {
        const t1 = Date.now();
        try {
          const page = await fetchPage(url);
          step('fetch_page', { url }, Date.now() - t1, true, `read for sub-question ${s.i}`);
          return page;
        } catch (err) {
          // A page that will not load is one failed step, not a failed search.
          step('fetch_page', { url }, Date.now() - t1, false, undefined, errorMessage(err));
          return null;
        }
      })
    );
    // In search-rank order, not in the order the downloads happened to finish.
    for (const page of pages) if (page) evidence.push({ kind: 'web', page, subQuestion: s.i });
  }
  return { evidence, capped };
}
