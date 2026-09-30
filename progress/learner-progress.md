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

- 2026-09-29: Step 8 (deep search) built, Plan-and-Execute: src/deep.ts — recall ‖ plan in parallel; plan_research = one json_schema LLM call (3–6 terse sub-questions + search query each), `plan` SSE before any retrieval; fan-out is CODE not LLM (per sub-q: search → top 3 unclaimed pages fetched in parallel; search_documents too in docs/auto+Space), budget split evenly so ≤ 24 steps; merge dedupes by URL / docId+locator in plan order, every step + source tagged subQuestion; structured answer (direct → ### per sub-q → Bottom line). Shared pieces pulled out of loop.ts (recallStep, routeFor, streamAnswer). src/quota.ts: DEEP_DAILY_CAP per user per UTC day, atomic conditional upsert (dup-key = over cap), counted at start; 429 {error, resetsAt next UTC midnight}. Deep answers save subQuestions; run log depth deep.
- Verified: 3 bench deep questions — plan before retrieval ✓, 4–5 sub-qs, 15–20/20 steps tagged, all sources tagged, citations resolve, 17–22 steps, $0.012–0.046, 14–26 s. Deep/quick sources 12 vs 5 = 2.4× on Q1; cost question only 8 sources (ratio risk → DEEP_FETCHES_PER_SUB_QUESTION=4 if bench flags). Plan time 5.1 s → 2.0–3.2 s after making the planner terse (plan length = latency). Cap: 6 simultaneous reservations at cap 2 → exactly 2 ok; HTTP 429 + resetsAt before any spend; quick still allowed.
- Learner learned: the plan streams first so the user can see/stop it, it's the first paint, and a plan after retrieval is a rationalisation.
- DESIGN.md open decision 2 answered: the day resets at UTC midnight; a deep search counts when it starts.

- 2026-09-30: /stats built (src/stats.ts): today = UTC day; service-wide except deepToday (per user). requests = new `requests` collection, one row per agent request (recordRequests middleware, not /health, fire-and-forget); answers (done|cap), costUsdToday (all runs), cache hit % and TTFT p95 aggregated from today's `runs` rows, which now also carry searches/cacheHits/ttftMs (file shape for check.mjs unchanged). Verified: 401 without user; +2 answers after 2 asks; /stats 56 answers / $0.348 = independent sum of today's runs/*.json files exactly. Gateway-rejected calls (401/400/429 at the edge) aren't counted — note for DESIGN.md.
- ALL BUILD STEPS DONE.

- 2026-09-30: FIRST OFFICIAL BENCH (learner ran it): 13/16 SLA + 20/22 caps. Pass: contract, 202 p95 265 ms, ingest decoupling 0.94×, recall@5 0.967, grounding 0.994, error rate 0, all deep checks (plan p95 2.4 s, ratio ≥ 2.5×, $0.031/deep), memory, stats reconcile, page locator, router picks docs. FAIL: ttft p95 22.6 s (≤ 2.5), answer p95 23.8 s (≤ 12), cache hit 35% (≥ 50%), deepCap429 (probe timed out).
- Diagnosis: deepCap429 = one deep answer hung 941 s — OpenAI SDK default timeout 10 min + 2 retries. Cache 35% = 6/20 repeats missed because the model reworded its search query; 50% needs EVERY repeat to hit. TTFT ≈ 12.7 s avg: tools ~3.5 s, the rest ≈ 4 sequential LLM turns at ~2 s each on this network.
- Fixes: (1) OpenAI timeouts (LLM 60 s, embeddings 20 s, maxRetries 1) + 30 s idle watchdog on the answer stream → ProviderError → 502. (2) Learner chose "first search by LUMINA": on a fresh thread in web mode (or auto with no Space) the harness searches the question as asked, in parallel with recall — one fewer LLM turn, repeats hit the cache; model still picks pages / may search again. Statement-only messages still just confirm the memory. Verified: repeat searchCached true, TTFT 15.3 s → 6.3 s on repeat.

- 2026-09-30: SECOND BENCH (cache still warm from run 1 → cache 75% is inflated): deepCap429 ✓ now (6th deep → 429 + resetsAt). New misses: 202 p95 332 ms (only 4 uploads, so p95 = slowest; network) and deep/quick 1.75× on the cost question (4 sub-qs, some 403s). TTFT 24.4 s / answer 27.9 s — network was worse (idle search p95 28 s).
- Fixes: DEEP_FETCHES_PER_SUB_QUESTION 3 → 4 (24-step budget still trims it for 5–6 sub-qs); upload writes GridFS file ‖ document row in parallel (GridFS id exists when the stream opens), job last → warm uploads 157–240 ms.

- 2026-09-30: DESIGN.md notes added (learner reasoned each Socratically, Claude shaped the wording): (1) harness recalls memory every answer — model might skip it, preference silently ignored, ~30 ms; (2) no re-rank — recall@5 0.967, the one miss is query rewording; (3) rate limit counts spend routes only (UI polls 40/min), in-process → 2 gateways = 60/min, shared store if scaled; (4) deep cap in Agent (gateway can be bypassed), UTC midnight, counted at start (failed runs spent money; race test); (5) /stats from the logs (two records drift). Learner answered 1, 3, 4 correctly; needed the answer for 2 (recall@5 + re-rank explained with a librarian analogy) and 5.
- Side questions covered: invoices → extract fields to a table + query, embeddings only for fuzzy questions; LUMINA memory types (working / thread / long-term; documents, cache, run logs are not memory); pgvector could hold long-term memory but the spec requires Atlas, and the post-filter trap applies there too.
- Weak spot: recall@5 / what retrieval metrics mean — revisit in Module 3.

- 2026-10-01: Deployed on Railway Singapore (web, gateway, agent, worker; agent/worker private). Eval vs deployed gateway: automated 73/85 (manual 15 left to grader — 0 there means "ungraded", not failed). Demo video recorded (Loom); report.json rebuilt with it and gateway redeployed — /evals/report.json now serves the video. Learner chose to keep the UI on Railway, not Vercel (deploy_docs says Vercel UI → may cost up to 5 pts; suggested flagging it in the submission message).

## Next step
- Submit: post the Railway web URL (+ /evals) with the note about Railway instead of Vercel.
- Optional before submitting: E2 error rate 13.6% (> 1%) and A3 fetch_page thrash (6–14 in a row, cap 4); 202 p95 426 ms; deep-cap probe "terminated".
- Then: Module 2 (Skills & Subagents). Optional: Module 1 quiz.
- Weak spot to revisit in Module 3: recall@5 / retrieval metrics.
