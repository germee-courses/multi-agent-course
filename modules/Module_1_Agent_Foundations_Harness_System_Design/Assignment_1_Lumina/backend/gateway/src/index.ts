/**
 * LUMINA gateway — the software backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 *
 * What is already here: the server, CORS, the request id, the pino request log, /health
 * (which nests the agent service's health), a 501 for every contract route, and the
 * static hosting of web/dist. That is deliberately the boring half.
 *
 * What you build (backend/gateway/, see README Part 2):
 *   1. X-User-Id enforcement           → 401 without it, on every route but /health
 *   2. zod validation from @lumina/contract → 400 on a bad body, with the zod message
 *   3. a per-user rate limit           → 429
 *   4. the proxy to the agent service, and SSE pass-through for /threads/:id/ask
 *   5. 502 for any upstream failure    → never a 2xx when the agent threw
 *
 * The browser talks ONLY to this service. No provider key is ever read here.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ZodError, ZodTypeAny } from 'zod';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER
} from '@lumina/contract';
import { env } from './env.js';
import { sseHeaders, sseSend } from './sse.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

// One request id, reused if the caller sent one, generated if not, forwarded to the agent
// service and logged by both. This is what makes one request greppable end to end.
app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? `req_${randomUUID().slice(0, 12)}`).trim();
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    // The ask route is a stream; one line when it closes is the useful line.
    autoLogging: true
  })
);

// JSON everywhere except the multipart upload route, which your handler owns.
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- every route: the edge, then the agent

/**
 * The gateway's whole job, in the order a request meets it:
 *
 *   1. X-User-Id       401 without it (every route but /health and the report)
 *   2. rate limit      429 {error, resetsAt}, per user, on the routes that SPEND
 *   3. contract        400 with the zod message, before the agent sees a bad body
 *   4. proxy           same method, path and body to the agent; its status comes back as is
 *   5. upstream down   502 — never a 2xx when the agent could not answer
 *
 * No provider key is read here and nothing is researched here: this service could be
 * replaced by a CDN rule and a proxy, and that is the point.
 */

const fail = (res: express.Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error, status, requestId: String(res.locals.requestId), ...extra });

/** Bodies the contract defines. Uploads are multipart and stream through untouched. */
const BODY_SCHEMAS: Partial<Record<string, ZodTypeAny>> = {
  'POST /threads': CreateThreadBody,
  'POST /threads/:threadId/ask': AskBody,
  'POST /spaces': CreateSpaceBody
};

/**
 * Only the routes that cost money count toward the limit: an answer (LLM + search) and an
 * upload (embeddings). Reads are free, and the UI polls document status every 1.5 s, so a
 * limit on everything would rate-limit the product against itself.
 */
const SPENDING = new Set(['POST /threads/:threadId/ask', 'POST /spaces/:spaceId/documents']);

/**
 * Sliding window per user, in this process. Correct for one gateway; with several, each
 * counts separately and the real limit is N × this one (DESIGN.md, open decision 1).
 */
const hits = new Map<string, number[]>();
function rateLimit(userId: string): { ok: true } | { ok: false; resetsAt: Date } {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= env.rateLimitPerMinute) {
    hits.set(userId, recent);
    return { ok: false, resetsAt: new Date(recent[0]! + 60_000) };
  }
  recent.push(now);
  hits.set(userId, recent);
  return { ok: true };
}

const zodMessage = (err: ZodError) => {
  const issue = err.issues[0];
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body';
};

// The eval skill writes this file; the UI's /evals page renders whatever is here.
app.get('/evals/report.json', async (_req, res) => {
  try {
    res.type('application/json').send(await readFile(env.reportFile, 'utf8'));
  } catch {
    fail(res, 404, 'no eval report yet: run the fde-lumina-eval skill to write reports/report.json');
  }
});

for (const route of ROUTES) {
  if (route.path === '/health' || route.path === '/evals/report.json') continue;
  const key = `${route.method} ${route.path}`;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';

  app[method](route.path, async (req, res) => {
    const userId = req.header(USER_HEADER)?.trim();
    if (route.auth && !userId) return fail(res, 401, 'X-User-Id header is required');

    if (userId && SPENDING.has(key)) {
      const limit = rateLimit(userId);
      if (!limit.ok) {
        const seconds = Math.max(1, Math.ceil((limit.resetsAt.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(seconds));
        return fail(res, 429, `rate limit: ${env.rateLimitPerMinute} per minute`, {
          resetsAt: limit.resetsAt.toISOString()
        });
      }
    }

    let body: string | undefined;
    const schema = BODY_SCHEMAS[key];
    if (schema) {
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return fail(res, 400, zodMessage(parsed.error));
      body = JSON.stringify(parsed.data);
    }

    await proxy(req, res, { body, streaming: key === 'POST /threads/:threadId/ask' });
  });
}

/**
 * Forward to the agent. JSON goes as the validated body; an upload streams the raw request
 * (multipart boundary and all). An ask that comes back as `text/event-stream` is piped
 * frame by frame and flushed, so the first token reaches the browser when the agent sends
 * it, not when the answer ends.
 */
async function proxy(
  req: express.Request,
  res: express.Response,
  { body, streaming }: { body?: string; streaming: boolean }
): Promise<void> {
  const requestId = String(res.locals.requestId);
  const headers: Record<string, string> = { [REQUEST_HEADER]: requestId };
  const userId = req.header(USER_HEADER);
  if (userId) headers[USER_HEADER] = userId;

  const upload = req.method === 'POST' && req.path.endsWith('/documents');
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (upload) {
    for (const h of ['content-type', 'content-length']) {
      const v = req.header(h);
      if (v) headers[h] = v;
    }
  }

  // The browser closing the tab stops the agent's work (and its spending) too.
  const closed = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) closed.abort();
  });
  const signal = streaming ? closed.signal : AbortSignal.any([closed.signal, AbortSignal.timeout(env.upstreamTimeoutMs)]);

  let upstream: Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: upload ? (Readable.toWeb(req) as ReadableStream) : body,
      signal,
      // Required by Node's fetch to send a streamed request body.
      ...(upload ? { duplex: 'half' } : {})
    } as RequestInit);
  } catch (err) {
    if (closed.signal.aborted) return;
    log.error({ err, requestId }, 'agent unreachable');
    fail(res, 502, `agent service unreachable: ${(err as Error).message}`);
    return;
  }

  if (upstream.headers.get('content-type')?.includes('text/event-stream') && upstream.body) {
    sseHeaders(res);
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
        // @ts-expect-error `flush` exists when a compression middleware is present; harmless otherwise.
        if (typeof res.flush === 'function') res.flush();
      }
    } catch (err) {
      // The agent died mid-answer. The 200 is already sent, so the failure is an SSE error
      // event: the client must not mistake a truncated answer for a finished one.
      if (!closed.signal.aborted) {
        log.error({ err, requestId }, 'agent stream broke');
        sseSend(res, 'error', { status: 502, error: `agent stream broke: ${(err as Error).message}` });
      }
    }
    res.end();
    return;
  }

  res.status(upstream.status);
  const type = upstream.headers.get('content-type');
  if (type) res.setHeader('content-type', type);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

// ---------------------------------------------------------------- static UI

// In production the gateway serves the built UI, so / and /evals come from one origin.
if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err, requestId: res.locals.requestId }, 'gateway error');
  res.status(502).json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
});

app.listen(env.port, () => {
  log.info(
    { port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins },
    'gateway up — proxying to the agent service'
  );
});
