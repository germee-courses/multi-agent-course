import { config } from 'dotenv';
import { resolve } from 'node:path';

// Both services read the single .env at the assignment root.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: num(process.env.PORT_GATEWAY ?? process.env.PORT, 8787),
  agentUrl: process.env.AGENT_URL ?? 'http://localhost:8000',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
  /** Non-streaming calls to the agent give up after this; an ask streams for as long as it runs. */
  upstreamTimeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 60_000),
  /** Written by the fde-lumina-eval skill (eval/build-report.mjs --out reports/report.json). */
  reportFile: resolve(process.cwd(), '../../reports/report.json'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Serve the built UI from the gateway in production so one host serves / and /evals. */
  webDist: resolve(process.cwd(), '../../web/dist')
} as const;
