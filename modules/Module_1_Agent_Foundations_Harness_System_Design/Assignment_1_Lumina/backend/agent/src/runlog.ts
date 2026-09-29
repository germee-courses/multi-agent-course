import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { COLLECTIONS, RunLog, type Depth, type RunDoc, type Terminated, type ToolName } from '@lumina/contract';
import { env } from './env.js';
import { db } from './db.js';

/**
 * The run log: one per answer, whatever happened — done, cap, OR error. A failed run is the
 * one you most need a record of, so the tally lives here, outside the loop, where it
 * survives the loop throwing.
 *
 * Written twice: `runs/<requestId>.json` in exactly the RunLog shape quality/check.mjs
 * reads, and the `runs` collection (same shape plus ids), which is what a deployed
 * instance has instead of a disk (`npm run export:runs` dumps it back to files).
 */
const log = pino({ level: env.logLevel });

export interface ToolCallRecord {
  name: ToolName;
  ok: boolean;
  error?: string;
  ms: number;
}

export class RunState {
  readonly started = Date.now();
  readonly toolCalls: ToolCallRecord[] = [];
  readonly tokens = { in: 0, out: 0 };
  embeddingTokens = 0;
  /** Every web_search the run made, and how many of those the cache answered. */
  searches = 0;
  cacheHits = 0;
  /** Set when the first token streams; stays null for a run that never answered. */
  ttftMs: number | null = null;

  addUsage(u?: { prompt_tokens?: number; completion_tokens?: number } | null): void {
    this.tokens.in += u?.prompt_tokens ?? 0;
    this.tokens.out += u?.completion_tokens ?? 0;
  }

  /** LLM + embeddings + the searches that actually reached the provider. */
  costUsd(): number {
    const usd =
      (this.tokens.in / 1e6) * env.llmInputUsdPerMtok +
      (this.tokens.out / 1e6) * env.llmOutputUsdPerMtok +
      (this.embeddingTokens / 1e6) * env.embeddingUsdPerMtok +
      (this.searches - this.cacheHits) * env.searchUsdPerCall;
    return Math.round(usd * 1e6) / 1e6;
  }
}

/** Extra fields on a `runs` row that /stats reads. */
export interface StatsFields {
  searches: number;
  cacheHits: number;
  ttftMs: number | null;
}

export interface RunMeta {
  requestId: string;
  userId: string;
  threadId: string;
  query: string;
  terminated: Terminated;
  depth: Depth;
  answerId?: string;
}

/**
 * Never throws: a log that cannot be written is reported loudly in the service log, but it
 * must not turn a delivered answer into an error after the fact.
 */
export async function writeRunLog(run: RunState, meta: RunMeta): Promise<void> {
  const entry = RunLog.parse({
    tokens: run.tokens.in + run.tokens.out + run.embeddingTokens,
    wallClockSec: Math.round((Date.now() - run.started) / 100) / 10,
    costUsd: run.costUsd(),
    terminated: meta.terminated,
    depth: meta.depth,
    toolCalls: run.toolCalls
  });

  // The request id can come from a client header; it must not be able to name a path.
  const file = join(env.runsDir, `${meta.requestId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  try {
    writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
  } catch (err) {
    log.error({ err, requestId: meta.requestId }, 'run log: file write failed');
  }

  try {
    // The file stays exactly the RunLog shape check.mjs reads. The collection row also
    // carries what /stats adds up, so /stats is computed from the log, not kept beside it.
    const doc: RunDoc & StatsFields = {
      ...entry,
      requestId: meta.requestId,
      userId: meta.userId,
      threadId: meta.threadId as RunDoc['threadId'],
      answerId: meta.answerId as RunDoc['answerId'],
      query: meta.query,
      searches: run.searches,
      cacheHits: run.cacheHits,
      ttftMs: run.ttftMs,
      createdAt: new Date()
    };
    await (await db()).collection<RunDoc & StatsFields>(COLLECTIONS.runs).insertOne(doc);
  } catch (err) {
    log.error({ err, requestId: meta.requestId }, 'run log: runs collection write failed');
  }
}
