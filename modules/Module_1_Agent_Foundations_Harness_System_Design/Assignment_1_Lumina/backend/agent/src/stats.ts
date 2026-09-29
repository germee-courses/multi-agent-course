import type express from 'express';
import pino from 'pino';
import {
  COLLECTIONS,
  REQUEST_HEADER,
  USER_HEADER,
  type RequestDoc,
  type RunDoc,
  type StatsResponse
} from '@lumina/contract';
import { env } from './env.js';
import { db } from './db.js';
import { deepSearchesToday } from './quota.js';
import type { StatsFields } from './runlog.js';

/**
 * /stats: today's numbers, computed from the durable record rather than kept beside it, so
 * they reconcile with the log by construction.
 *
 *   requests                one `requests` row per call this service handled
 *   answers, cost, cache,   today's `runs` rows (the same writes as runs/<id>.json)
 *   ttft p95
 *   deepToday               THIS user's deep searches today (quota.ts)
 *
 * Service-wide, except deepToday. "Today" is the UTC day, the same boundary as the deep
 * cap. Calls the gateway rejected itself (401, 400, 429) never reach this service and are
 * not counted; /health is monitoring noise and is not counted either.
 */

const log = pino({ level: env.logLevel });

const startOfUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Express middleware: one `requests` row per request, written after the response, never awaited. */
export function recordRequests(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.path === '/health') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const doc: RequestDoc = {
      requestId: req.header(REQUEST_HEADER) ?? '',
      userId: req.header(USER_HEADER) ?? '',
      // The route pattern, not the URL: "/threads/:threadId/ask", so rows group by endpoint.
      route: `${req.method} ${req.route?.path ?? req.path}`,
      status: res.statusCode,
      ms: Date.now() - t0,
      createdAt: new Date()
    };
    void db()
      .then((d) => d.collection<RequestDoc>(COLLECTIONS.requests).insertOne(doc))
      .catch((err) => log.error({ err, requestId: doc.requestId }, 'requests: write failed'));
  });
  next();
}

export async function stats(userId: string): Promise<StatsResponse> {
  const since = startOfUtcDay();
  const database = await db();
  const [requests, [runs], ttfts, deepToday] = await Promise.all([
    database.collection<RequestDoc>(COLLECTIONS.requests).countDocuments({ createdAt: { $gte: since } }),
    database
      .collection<RunDoc & StatsFields>(COLLECTIONS.runs)
      .aggregate<{ answers: number; cost: number; searches: number; hits: number }>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            // An answer is a run that streamed one: done, or an honest partial at the cap.
            answers: { $sum: { $cond: [{ $in: ['$terminated', ['done', 'cap']] }, 1, 0] } },
            // Cost counts every run, failed ones included: they spent too.
            cost: { $sum: '$costUsd' },
            searches: { $sum: { $ifNull: ['$searches', 0] } },
            hits: { $sum: { $ifNull: ['$cacheHits', 0] } }
          }
        }
      ])
      .toArray(),
    database
      .collection<RunDoc & StatsFields>(COLLECTIONS.runs)
      // $ne null also skips rows written before this field existed (missing counts as null).
      .find({ createdAt: { $gte: since }, ttftMs: { $ne: null } }, { projection: { ttftMs: 1 } })
      .toArray(),
    deepSearchesToday(userId)
  ]);

  return {
    requests,
    answers: runs?.answers ?? 0,
    searchCacheHitRatePct: runs?.searches ? Math.round((1000 * runs.hits) / runs.searches) / 10 : 0,
    ttftP95Ms: p95(ttfts.map((r) => r.ttftMs as number)),
    costUsdToday: Math.round((runs?.cost ?? 0) * 10_000) / 10_000,
    deepToday,
    deepDailyCap: env.deepDailyCap
  };
}

/** Nearest-rank 95th percentile; 0 when there is nothing to rank. */
function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}
