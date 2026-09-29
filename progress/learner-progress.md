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
- 2026-09-29: Repo pushed to private github.com/germee-courses/multi-agent-course (remote `germee`; `origin` = teacher, pull with `git pull origin main`). Merged teacher's 6 new commits cleanly.
- 2026-09-29: Step 6a (Spaces + upload) built: src/spaces.ts; POST/GET /spaces, POST /spaces/:id/documents (multer memory, 25 MB → 413, pdf/md/txt by MIME or extension → else 400, GridFS → pending doc → job, 202), GET /spaces/:id/documents. Verified 401/404 (other user)/400/413; 202 in ~206 ms on good network.
- 2026-09-29: Step 6b (jobs worker) built: src/ingest.ts (pdfjs page-aware; md by heading; txt by line; ~1200-char chunks, 150 overlap, never cross a locator), embedMany in memory.ts, src/worker.ts (atomic claim, heartbeat claimedAt, sweeper w/ max attempts, resume via chunk ids `<docId>_<ord>`, read-your-write probe, fail loud). Config in env.ts. Verified: md + gold PDF (4 pages → 9 chunks, page locators); probe waited 4.5–17.8 s (eventual consistency is real); kill -9 mid-embedding → sweeper returned job → attempt 2 reused 4/7 chunks → indexed.
- Fixed kit bug in db.ts: failed first connect cached a closed client ("Topology is closed" forever). Tell instructor.
- Learner learned: 202 + worker keeps the single Node thread free for streaming; atomic claim prevents two workers doing the same job (answered correctly).
- Network: learner's public IP changes (180.190.169.191 → 112.201.107.157); Atlas SSL alert 80 = IP not on access list. On slow network Atlas ping 150–330 ms → upload 3–12 s. Recheck upload < 300 ms on a stable connection.

- 2026-09-29: Step 7 (hybrid RAG + router) built: src/tools/documents.ts ($vectorSearch + chunks_text BM25 in parallel, both filtered by spaceId+userId inside the stage, RRF k=60, similarity gate, dedupe identical passages, top 5; no re-rank, reason in code comment), router in loop.ts (web | docs = search_documents forced on turn 1 | auto = model picks from Space file list, reason in trace), doc sources numbered by rank with locator + whole chunk as snippet; 400 docs w/o spaceId, 404 other user's space. Config in env.ts (DOC_TOP_K, DOC_CANDIDATES, RRF_K, DOC_MIN_VECTOR_SCORE=0.62).
- Calibration: on-topic top hits 0.67–0.86, off-topic 0.50–0.56 → floor 0.62 (0.7 would have dropped the k1 answer).
- Verified: docs k1 → [1] retrieval-basics.pdf p.1, "1.2 [1]"; auto churn → model chose docs ("likely documented in our own materials"), cites note.md § Churn plan; off-topic → searched twice, no sources, "could not find". Latency 17–71 s = network (OpenAI unreachable within 10 s at the time), not code.
- Learner learned: BM25 catches exact rare tokens (k1); vectors catch synonyms (car/automobile); RRF fuses ranks because scores aren't comparable.

- 2026-09-29: recall@5 measured with a scratch script using bench.mjs's exact hit rule (agent :8001, mode docs, fresh Space with the 4 gold files): **29/30 = 0.97** (bench subset), 38/39 overall. No re-rank needed. The one miss (g27, "terminated" values) is the model's rewritten query ("terminated field values") losing context — the raw question ranks the right chunk #1. Left as is (don't overfit one gold item); revisit if real questions show it (Module 3: query transformation).
- Gap found: the gateway (backend/gateway) is still all 501; the official bench targets it (:8787). Needs its own step.

- 2026-09-29: Gateway built (backend/gateway/src/index.ts): per contract route → 401 no X-User-Id → 429 {error, resetsAt} + Retry-After (sliding window, in-process, SPENDING routes only: ask + upload, because the UI polls docs every 1.5 s) → zod 400 → proxy (JSON validated body; upload streams raw multipart; ask pipes SSE frame by frame; browser disconnect aborts upstream; 60 s timeout on non-streaming) → 502 when agent unreachable, SSE error event if stream breaks. Serves reports/report.json at /evals/report.json (404 until the eval skill writes it).
- Verified through :8787: 401, 400, 404 (other user's space), 202 upload, 429 on 4th of 3/min, 502 agent down, X-Request-Id reused/echoed and found in agent answer log, SSE not buffered (trace@4s … token@16s … done@17s).
- Kit quirk: gateway /health gives the agent 3 s; on slow network agent's DB ping exceeds it → flaps to "down". Left as is.
- DESIGN.md open decision 1 now answered: in-process counters, spend routes only; with N gateways the effective limit is N × 30.

## Next step
- Run the official `npm run bench` (through :8787) on a stable network: web workload, routerPicksDocs, pageLocator, 202 p95 < 300 ms, decoupling. Deep search rows will fail until step 8.
- DESIGN.md (learner's voice): (1) recall_memory run by harness every answer; (2) why no re-rank step (small Space, RRF baseline, TTFT already over budget; revisit if recall@5 < 0.70).
- Then step 8: deep search (plan_research + plan event before retrieval).
- Optional later: Module 1 quiz; reconciliation agent build.
