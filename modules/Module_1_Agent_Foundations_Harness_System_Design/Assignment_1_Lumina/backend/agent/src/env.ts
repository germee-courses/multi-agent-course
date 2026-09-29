import { config } from 'dotenv';
import { resolve } from 'node:path';

// The single .env at the assignment root. Provider keys are read HERE and nowhere else.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const env = {
  port: num(process.env.PORT_AGENT ?? process.env.PORT, 8000),
  mongoUri: process.env.MONGODB_URI ?? '',
  mongoDb: process.env.MONGODB_DB ?? 'lumina',
  vectorBackend: (process.env.VECTOR_BACKEND ?? 'atlas-vector-search') as
    | 'atlas-vector-search'
    | 'mongo-cosine-scan',

  llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
  llmModel: process.env.LLM_MODEL ?? 'claude-sonnet-5',

  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily') as 'tavily' | 'serpapi',
  searchCacheTtlSeconds: num(process.env.SEARCH_CACHE_TTL_SECONDS, 21600),

  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',

  // What an answer costs, so `done.costUsd` is measured rather than guessed. The defaults
  // are gpt-4.1-mini's published rates at the time of writing — check your provider's
  // pricing page and override in .env if they have changed or you switch model.
  llmInputUsdPerMtok: num(process.env.LLM_INPUT_USD_PER_MTOK, 0.4),
  llmOutputUsdPerMtok: num(process.env.LLM_OUTPUT_USD_PER_MTOK, 1.6),
  searchUsdPerCall: num(process.env.SEARCH_USD_PER_CALL, 0.008),
  embeddingUsdPerMtok: num(process.env.EMBEDDING_USD_PER_MTOK, 0.02),

  // Deep search is the expensive gear, so its limits are configuration, not code.
  deepSubQuestionsMin: num(process.env.DEEP_SUB_QUESTIONS_MIN, 3),
  deepSubQuestionsMax: num(process.env.DEEP_SUB_QUESTIONS_MAX, 6),
  deepDailyCap: num(process.env.DEEP_DAILY_CAP, 5),

  // The hard caps from AGENTS.md. Raising these to make a gate pass is the failure mode
  // the caps exist to catch. Two gears, two envelopes.
  maxToolCalls: num(process.env.MAX_TOOL_CALLS, 8),
  maxWallClockSec: num(process.env.MAX_WALL_CLOCK_SEC, 90),
  maxToolCallsDeep: num(process.env.MAX_TOOL_CALLS_DEEP, 24),
  maxWallClockSecDeep: num(process.env.MAX_WALL_CLOCK_SEC_DEEP, 240),

  // Ingestion (the jobs worker). Chunks never cross a page or heading, so each one has a
  // single locator; the overlap keeps a sentence split at a boundary findable from both sides.
  chunkChars: num(process.env.CHUNK_CHARS, 1200),
  chunkOverlapChars: num(process.env.CHUNK_OVERLAP_CHARS, 150),
  embedBatchSize: num(process.env.EMBED_BATCH_SIZE, 64),
  workerPollMs: num(process.env.WORKER_POLL_MS, 1000),
  /** A `running` job whose claimedAt is older than this is presumed dead and swept back. */
  jobStaleSec: num(process.env.JOB_STALE_SEC, 300),
  /** A job that has crashed a worker this many times is failed, not retried forever. */
  jobMaxAttempts: num(process.env.JOB_MAX_ATTEMPTS, 3),
  /** How long the read-your-write probe waits for Atlas to make a new chunk searchable. */
  probeTimeoutSec: num(process.env.PROBE_TIMEOUT_SEC, 60),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Where the per-answer run logs land. quality/check.mjs reads this folder. */
  runsDir: resolve(process.cwd(), '../../runs')
} as const;

/** Never log or return these. /health names the model; it never echoes a key. */
export const secrets = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  openai: process.env.OPENAI_API_KEY ?? '',
  tavily: process.env.TAVILY_API_KEY ?? '',
  serpapi: process.env.SERPAPI_API_KEY ?? ''
} as const;
