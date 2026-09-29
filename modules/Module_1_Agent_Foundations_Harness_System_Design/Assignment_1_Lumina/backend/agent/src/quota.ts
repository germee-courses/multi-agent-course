import { MongoServerError } from 'mongodb';
import { env } from './env.js';
import { db } from './db.js';

/**
 * The deep-search spend gate: DEEP_DAILY_CAP per X-User-Id per day, enforced HERE, next to
 * the spending. A cap in the gateway is a cap you bypass by calling the agent directly.
 *
 * One counter document per (user, UTC day). The check and the increment are ONE atomic
 * operation — "increment if still under the cap, creating the row if needed" — so two deep
 * searches started in the same instant cannot both squeeze past the last slot. When the
 * row is at the cap the filter matches nothing, the upsert tries to insert a duplicate
 * _id, and Mongo's duplicate-key error IS the "over cap" answer.
 *
 * A search counts when it starts, whatever happens after: a run that failed half way still
 * spent money. The day is UTC, so `resetsAt` is the next UTC midnight.
 */

interface DeepUsageDoc {
  _id: string;
  userId: string;
  day: string;
  count: number;
  createdAt: Date;
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

async function usage() {
  return (await db()).collection<DeepUsageDoc>('deepUsage');
}

export async function reserveDeepSearch(
  userId: string
): Promise<{ ok: true; used: number } | { ok: false; resetsAt: Date }> {
  const day = utcDay();
  try {
    const row = await (await usage()).findOneAndUpdate(
      { _id: `${userId}:${day}`, count: { $lt: env.deepDailyCap } },
      { $inc: { count: 1 }, $setOnInsert: { userId, day, createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    return { ok: true, used: row?.count ?? 1 };
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) return { ok: false, resetsAt: nextUtcMidnight() };
    throw err;
  }
}

/** For /stats: how many deep searches this user has started today. */
export async function deepSearchesToday(userId: string): Promise<number> {
  const row = await (await usage()).findOne({ _id: `${userId}:${utcDay()}` });
  return row?.count ?? 0;
}
