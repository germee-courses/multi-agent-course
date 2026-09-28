import { createHash } from 'node:crypto';
import pino from 'pino';
import { COLLECTIONS, type SearchCacheDoc } from '@lumina/contract';
import { env } from './env.js';
import { db } from './db.js';
import { webSearch, type SearchResult } from './tools/search.js';

/**
 * The two-tier search cache: an in-process LRU in front of the Mongo `searchCache`
 * collection. Neither tier is authoritative — delete both and answers are still correct,
 * only slower and dearer.
 *
 *   key      sha256(provider + normalized query). The provider is in the key so that
 *            flipping SEARCH_PROVIDER never serves the other provider's results.
 *   expiry   SEARCH_CACHE_TTL_SECONDS (6 h default). Mongo's TTL index deletes old rows,
 *            but only on a ~60 s sweep, so reads also check expiresAt; and the LRU has no
 *            TTL index at all, so it checks expiresAt itself.
 *
 * Only successful searches are cached. A provider error throws straight through: caching
 * a failure would turn one outage into six hours of "no results".
 */
const log = pino({ level: env.logLevel });

const LRU_MAX = 500;
const lru = new Map<string, { results: SearchResult[]; expiresAt: number }>();

export function normalizeQuery(query: string): string {
  return query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function cacheKey(provider: string, query: string): string {
  return createHash('sha256').update(`${provider}\n${normalizeQuery(query)}`).digest('hex');
}

export async function cachedSearch(query: string): Promise<{ results: SearchResult[]; cached: boolean }> {
  const provider = env.searchProvider;
  const key = cacheKey(provider, query);
  const now = Date.now();

  // Tier 1: this process's memory.
  const hot = lru.get(key);
  if (hot && hot.expiresAt > now) {
    lru.delete(key); // re-insert so it counts as most recently used
    lru.set(key, hot);
    return { results: hot.results, cached: true };
  }
  if (hot) lru.delete(key);

  // Tier 2: Mongo. A cache that cannot be read is a slower search, not a failed one — so
  // this falls through to the provider, and says so in the log.
  const rows = await searchCache().catch((err) => {
    log.warn({ err }, 'searchCache unavailable; searching without it');
    return null;
  });
  if (rows) {
    const row = await rows.findOne({ _id: key, expiresAt: { $gt: new Date(now) } }).catch((err) => {
      log.warn({ err }, 'searchCache read failed; searching without it');
      return null;
    });
    if (row) {
      const results = row.results as unknown as SearchResult[];
      remember(key, results, new Date(row.expiresAt).getTime());
      return { results, cached: true };
    }
  }

  // Tier 3: the provider. Errors propagate: fail loud.
  const results = await webSearch(query);
  const expiresAt = new Date(now + env.searchCacheTtlSeconds * 1000);
  remember(key, results, expiresAt.getTime());
  if (rows) {
    await rows
      .updateOne(
        { _id: key },
        {
          $set: {
            provider,
            query: normalizeQuery(query),
            results: results as unknown as Record<string, unknown>[],
            expiresAt,
            createdAt: new Date(now)
          }
        },
        { upsert: true }
      )
      .catch((err) => log.warn({ err }, 'searchCache write failed'));
  }
  return { results, cached: false };
}

function remember(key: string, results: SearchResult[], expiresAt: number): void {
  lru.set(key, { results, expiresAt });
  if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value!);
}

async function searchCache() {
  return (await db()).collection<SearchCacheDoc>(COLLECTIONS.searchCache);
}
