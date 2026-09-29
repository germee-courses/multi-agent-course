/**
 * LUMINA agent service — the AI backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 * This is where the real work is. Provider keys live only in this process.
 *
 * What is already here: the server, /health (Mongo ping + which model, provider and
 * vector backend are live), and a 501 for every other route.
 *
 * What you build (README Part 1, in this order — each step is testable with curl -N):
 *   1. the QUICK loop: plan → choose tool → observe → repeat → answer, with web_search
 *      and fetch_page, streaming trace → sources → token → done. sources BEFORE the
 *      first token. Disable compression on this route and flush after every event.
 *   2. the search cache: in-process LRU over the searchCache collection (TTL index),
 *      key = sha256(normalized query + provider). searchCached only when every hit.
 *   3. threads + messages, so a follow-up sees the thread.
 *   4. memory: save_memory / recall_memory over the memories vector index; GET /memory,
 *      DELETE /memory/:id.
 *   5. the run log: one runs/<requestId>.json per answer, in the RunLog shape from the
 *      contract. Ten lines. The gates read it, so it is not optional.
 *   6. spaces + the jobs worker: upload → GridFS → parse → chunk → embed → upsert →
 *      read-your-write probe → indexed.
 *   7. hybrid retrieval: $vectorSearch + $search fused with RRF, page locators.
 *   8. DEEP search (depth: "deep"): plan_research decomposes the question into 3–6
 *      sub-questions, you stream a `plan` event BEFORE retrieving anything, research each
 *      sub-question, then merge the results into ONE citation numbering and synthesise.
 *      Every trace step and every source carries the subQuestion it served. Deep runs
 *      under the wider caps (maxToolCallsDeep, maxWallClockSecDeep) and behind
 *      DEEP_DAILY_CAP → 429 {error, resetsAt}.
 *
 * Three rules to hold on to while you write it:
 *   - Fail loud. A provider exception ends the run with terminated:"error" and a 502.
 *     Never a try/catch that returns a plausible answer. (Live Translate served English
 *     for weeks because of exactly that catch.)
 *   - Grounded or nothing. A citation that does not resolve to something retrieved in
 *     THIS request is an automatic fail.
 *   - Depth is opted into, never drifted into. A quick search may not call plan_research,
 *     however much the model would like to. Deep costs several times more, and a product
 *     that escalates itself is a product with an unbounded bill.
 */
import express from 'express';
import multer from 'multer';
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import type { ZodError } from 'zod';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  MAX_UPLOAD_BYTES,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER,
  newId,
  type Terminated
} from '@lumina/contract';
import { env } from './env.js';
import { pingDb } from './db.js';
import { Sse } from './sse.js';
import { runQuickAnswer } from './loop.js';
import {
  createThread,
  findThread,
  getThread,
  listThreads,
  loadHistory,
  saveAnswer,
  saveUserMessage
} from './threads.js';
import { deleteMemory, listMemories } from './memory.js';
import { RunState, writeRunLog } from './runlog.js';
import { acceptedType, createSpace, findSpace, listDocuments, listSpaces, uploadDocument } from './spaces.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- threads + ask (steps 1–3)

const fail = (res: express.Response, status: number, error: string) =>
  res.status(status).json({ error, status });

/** "query: Required" rather than a bare "Required". */
const zodMessage = (err: ZodError) => {
  const issue = err.issues[0];
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body';
};

app.post('/threads', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    const body = CreateThreadBody.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, zodMessage(body.error));
    res.status(201).json({ threadId: await createThread(userId, body.data.title) });
  } catch (err) {
    next(err);
  }
});

app.get('/threads', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    res.json(await listThreads(userId));
  } catch (err) {
    next(err);
  }
});

app.get('/threads/:threadId', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    const thread = await findThread(req.params.threadId, userId);
    if (!thread) return fail(res, 404, `unknown thread ${req.params.threadId}`);
    res.json(await getThread(thread));
  } catch (err) {
    next(err);
  }
});

app.post('/threads/:threadId/ask', async (req, res) => {
  const requestId = req.header(REQUEST_HEADER) ?? newId('req');
  const userId = req.header(USER_HEADER);
  if (!userId) return fail(res, 401, 'X-User-Id header is required');
  const body = AskBody.safeParse(req.body);
  if (!body.success) return fail(res, 400, zodMessage(body.error));

  const { query, depth, mode } = body.data;
  // Not built yet. An honest 501 beats quietly running a quick web search instead.
  if (depth === 'deep') return fail(res, 501, 'not implemented yet: deep search');
  if (mode === 'docs') return fail(res, 501, 'not implemented yet: document search');

  const sse = new Sse(res);
  // The run's tally lives out here so the run log survives the loop throwing. `run` stays
  // null until an answer actually starts: a 404 is a rejected request, not a run.
  let run: RunState | null = null;
  let terminated: Terminated = 'error';
  let answerId: string | undefined;
  try {
    const thread = await findThread(req.params.threadId, userId);
    if (!thread) return fail(res, 404, `unknown thread ${req.params.threadId}`);

    // History first (so it does not include this question), then record the question.
    const history = await loadHistory(thread._id, userId);
    await saveUserMessage(thread, query);

    run = new RunState();
    const r = await runQuickAnswer({ query, history, userId, threadId: thread._id }, sse, run);
    terminated = r.terminated;
    answerId = r.answerId;
    // The answer is saved only once it finished (done or an honest cap). A run that threw
    // saves nothing: a half-streamed answer must not come back as if it were complete.
    await saveAnswer(thread, { content: r.content, sources: r.sources, done: r.done });
    log.info(
      {
        requestId,
        userId,
        toolCalls: r.toolCalls.length,
        terminated: r.terminated,
        tokens: r.tokens,
        costUsd: r.costUsd,
        searchCached: r.searchCached,
        ttftMs: r.ttftMs,
        latencyMs: r.latencyMs
      },
      'answer'
    );
  } catch (err) {
    // Fail loud. Before anything has streamed this is a real HTTP 502; once the 200 stream
    // is open, it is an SSE error event carrying 502. Never a plausible answer.
    const error = (err instanceof Error ? err.message : String(err)).trim() || 'upstream failure';
    log.error({ requestId, userId, terminated: 'error', toolCalls: run?.toolCalls.length ?? 0, err }, 'answer failed');
    if (sse.started) sse.send('error', { status: 502, error });
    else if (!res.headersSent) res.status(502).json({ error, status: 502, requestId });
  } finally {
    sse.end();
    // After the stream has closed, so writing the log never delays the user.
    if (run) {
      await writeRunLog(run, { requestId, userId, threadId: req.params.threadId, query, terminated, depth: 'quick', answerId });
    }
  }
});

// ---------------------------------------------------------------- memory (step 4)

app.get('/memory', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    res.json(await listMemories(userId));
  } catch (err) {
    next(err);
  }
});

app.delete('/memory/:memoryId', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    if (!(await deleteMemory(userId, req.params.memoryId))) {
      return fail(res, 404, `unknown memory ${req.params.memoryId}`);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- spaces + upload (step 6a)

app.post('/spaces', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    const body = CreateSpaceBody.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, zodMessage(body.error));
    res.status(201).json(await createSpace(userId, body.data.name));
  } catch (err) {
    next(err);
  }
});

app.get('/spaces', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    res.json(await listSpaces(userId));
  } catch (err) {
    next(err);
  }
});

// The file is held in memory only long enough to hand it to GridFS; 25 MB is the ceiling.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

app.post('/spaces/:spaceId/documents', (req, res, next) => {
  const userId = req.header(USER_HEADER);
  if (!userId) return fail(res, 401, 'X-User-Id header is required');
  upload.single('file')(req, res, async (uploadErr: unknown) => {
    try {
      if (uploadErr instanceof multer.MulterError) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'file is larger than 25 MB');
        return fail(res, 400, `upload: ${uploadErr.message}`);
      }
      if (uploadErr) throw uploadErr;
      if (!req.file) return fail(res, 400, 'file: a multipart field named "file" is required');
      const mimeType = acceptedType(req.file);
      if (!mimeType) return fail(res, 400, `file: ${req.file.originalname} is not a PDF, Markdown, or text file`);

      const space = await findSpace(req.params.spaceId, userId);
      if (!space) return fail(res, 404, `unknown space ${req.params.spaceId}`);

      const docId = await uploadDocument(space, req.file, mimeType);
      res.status(202).json({ docId, status: 'pending' });
    } catch (err) {
      next(err);
    }
  });
});

app.get('/spaces/:spaceId/documents', async (req, res, next) => {
  try {
    const userId = req.header(USER_HEADER);
    if (!userId) return fail(res, 401, 'X-User-Id header is required');
    if (!(await findSpace(req.params.spaceId, userId))) return fail(res, 404, `unknown space ${req.params.spaceId}`);
    res.json(await listDocuments(req.params.spaceId, userId));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- everything else: 501

const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res.status(501).json({ error: `not implemented yet: ${route}. Build it in backend/agent/src/.`, status: 501 });
};

for (const route of ROUTES) {
  if (route.path === '/health' || route.path === '/evals/report.json') continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, notImplemented(`${route.method} ${route.path}`));
}

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'agent error');
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      }
    },
    'agent up — every route but /health returns 501 until you build it'
  );
});
