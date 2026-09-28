# Learner Progress

<!-- Claude reads this at the start of each session and updates it at the end.
     Learners: you don't need to touch this — Claude maintains it. -->

## Learner profile
- Name: [unset]
- Preferred learning style: Build-along
- Started: 2026-09-25
- Last session: 2026-09-25

## Module status

| Module | Status | Notes / weak spots |
|--------|--------|--------------------|
| 01 — Agent Foundations, Agent Harness & System Design | in progress | Core concepts done (agent, loop/ReAct, stop_reason, harness, levels) via running example: Excel reconciliation agent. Strong — independently reasoned that the LLM only needs schema/samples while a script does the matching (context management). Skipped: exercises, quiz. |
| 02 — Skills & Subagents: Product Architecture & Coordination | not started | |
| 03 — Production Agentic RAG & AI Systems | not started | |
| 04 — Multi-Agent Systems & Orchestration | not started | |
| 05 — Real-Time Voice Agents & Conversational Systems | not started | |
| 06 — Leading AI Systems Across Teams | not started | |
| 07 — Demo Day (EPYHIA) | not started | |

Status values: not started · in progress · completed · needs review

## Weak spots to revisit
- [none yet]

## LUMINA setup (done 2026-09-25)
- Atlas M0 (Hong Kong region — watch latency vs 2.5s TTFT), indexes created, 3/3 search indexes (sample_mflix dropped to free the slot).
- LLM_PROVIDER=openai, LLM_MODEL=gpt-4.1-mini; Tavily search; SerpAPI key still needed later for the provider-swap Must.
- Agent moved to PORT_AGENT=8001 (roni-ai Python server holds 127.0.0.1:8000).
- Start dev with: `VITE_API_URL=http://localhost:8787 npm run dev` (Vite doesn't read root .env — kit bug; fix is envDir: '..' in web/vite.config.ts; tell instructor).
- UI shows "Not implemented yet" (501) panels = starting line reached.

## LUMINA build log
- 2026-09-27: DESIGN.md written in own voice, fact-checked against repo (PASS).
- 2026-09-28: Step 1 (quick loop) built in backend/agent: sse.ts, tools/search.ts (tavily|serpapi), tools/fetch.ts (readability), loop.ts (research loop + cap + fail loud + verbatim snippets + citation filter), POST /threads + POST /threads/:id/ask. Tested via curl on :8001: happy path OK; provider down -> trace ok:false + SSE error 502; 401/400/404/501 OK.
- 2026-09-28: Step 2 (search cache) built: src/cache.ts (LRU 500 + Mongo searchCache, key sha256(provider+normalized query), expiresAt checked on read in both tiers). Verified: cold 3.1s → LRU 0ms → Mongo after restart ~30-50ms; searchCached true only when all hits; search cost only on misses.
- Learner learned: 502 only when OUR tool/provider is broken; world refusing (403s) → honest answer. Provider in cache key so SEARCH_PROVIDER flip is real.
- 2026-09-28: Step 3 (threads + messages) built: src/threads.ts; GET /threads, GET /threads/:id, history (last 6 msgs, [n] stripped) to BOTH research + answer steps; title from first question; answer saved only after done/cap. Verified follow-up "How much does it cost?" searched "MongoDB Atlas Vector Search pricing"; other user → 404.
- Learner learned: follow-ups need history in both research and answer (answered (a) at first).
- 2026-09-28: Step 4 (memory) built: src/memory.ts (embed, recall via $vectorSearch filtered by userId, save w/ exact-dup check, list, delete); recall_memory run by the HARNESS every answer (design choice — tell learner to note it in DESIGN.md); save_memory model-chosen; memories are 'not sources, never cite'. Verified: Spanish pref saved in thread A → thread B answered in Spanish → DELETE (other user 404) → thread C English.
- Learner learned: save only stable facts ABOUT the user (picked only Spanish; missed vegetarian).
- 2026-09-28: Step 5 (run log) built: src/runlog.ts (RunState outside loop; runs/<id>.json + runs collection; written in finally after stream closes; no log for 400/401/404). Deliberate failure (blank TAVILY_API_KEY, uncached question) → runs/failing/req_step5_fail.json. check.mjs exit 1 (A2 ✓, P1 pending human, P2 intentional warning). WEEK 1 BUILD COMPLETE.
- Learner learned: every run logs (done/cap/error); SEARCH_PROVIDER picks one provider, no fallback; cache can mask a dead key.
- Known gap: TTFT ~14.5s / latency ~15s vs SLA 2.5s / 12s — tune later.
- Learner prefers: teacher's build order, with teaching aids (diagram + check question) per step. Learner supervises; Claude writes code.

## Next step
- Step 6: Spaces + jobs worker (upload → GridFS → 202 → parse → chunk → embed → probe → indexed). Remember: learner chose separate `npm run worker` process.
- Consider adding to DESIGN.md: recall_memory run by harness every answer (design choice).
- Optional later: Module 1 quiz; reconciliation agent build.
