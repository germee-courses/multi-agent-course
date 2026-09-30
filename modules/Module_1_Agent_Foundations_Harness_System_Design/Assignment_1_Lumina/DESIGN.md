# DESIGN.md — LUMINA

Before anything, I'm not very technical, and when I read the questions, I barely understood them even after watching Hamza's lecture.  I needed the help of LLMs to write the answers, and review it against the spec of the project.  I will try to do my best to understand these, and write in my own voice.

## Components

Lumina has the following components:
3 runtime services
1 database
3 pieces of state

There's a React UI, deployed as its own service on Railway next to the Gateway, Agent and worker.  This talks to the Gateway.
The Gateway is a public Express service that handles CORS, the X-User-Id check, the X-Request-Id, pino request logging, zod validation against `packages/contract`, the rate limit per user, and SSE pass-through.

The Agent service has a loop with six tools, quick and deep search, memory, document retrieval, run logs, and the deep-search daily cap.  The jobs worker runs off the request thread, which is a separate `npm run worker` process.

MongoDB is the database that also holds vectors, and GridFS for raw uploads.

The Agent calls the LLM, OpenAI embeddings, and Tavily or SerpApi for search (switchable with `SEARCH_PROVIDER`).

The three stateful pieces that are not services:
the `jobs` collection (the ingestion queue)
the two-tier search cache (an in-process LRU inside the Agent in front of the Mongo `searchCache` collection)
the run logs (one per answer)

## Responsibilities

The React UI is only frontend client.  It does not hold a key, and does not call the LLM or Agent directly.

The Gateway is the bridge between the browser, and the backend.  It is the one that rejects a request at the edge: 401 without X-User-Id, 400 for a body that fails the contract, and 429 for the rate limit.  It reuses or generates the request id.  It does not research, answer, or hold provider keys, and when the Agent fails it returns 502.

The Agent holds provider keys, and calls the LLM, embedding, and search providers.  Since it owns the loop, it decides that a run is over its cap (8 tool calls and 90 sec for quick, 24 tool calls and 240 sec for deep).  It sets `terminated` to `done`, `cap`, or `error`.  It is also where the deep daily cap is enforced (`DEEP_DAILY_CAP` per X-User-Id, returning `429 {error, resetsAt}`).  

`plan_research` is removed from the tool list on quick runs instead of being stopped at the prompt.
An explicit call of the `save_memory` tool writes to long-term memory.

Recalling memory is done by the harness on every answer, not left to the model. If the model decided, it could skip checking memory whenever the question gives no hint, and the answers would not be consistent: a saved preference like "answer in Spanish" would be silently ignored.  Checking every time costs about 30 ms per answer, which is worth it.
The jobs worker moves a document from pending to indexed, the upload handler stores the file, inserts the pending document and its job, and returns.

## Communication

The browser talks to the Gateway over HTTP, and sends X-User-Id on every call except `/health`.
The Gateway reuses an inbound X-Request-Id, or generates one if there is none, forwards it to the Agent, and returns it on the response.

The `POST /threads/{id}/ask` route uses Server-Sent Events (SSE), so the user can see answers from Lumina already while it is still working.  In a quick run, Lumina sends a trace, sources, tokens, and done.  trace shows what the Agent is doing, source shows the evidence it found, tokens are the parts of the answer being generated, and done means that the answer is complete.

In a deep run, Lumina creates a plan first to show how it will break the question into smaller sub-questions.  It then does the same process, but each research step and source is connected to the sub-question that used it.  The sources event has to come before the first token, so the citations in the answer point to sources that Lumina retrieved before generating the answer.

The Gateway and the Agent communicate via internal HTTP.  The Gateway receives the request from the browser, and sends it to the Agent, which does the research.  Compression is disabled on the ask route, and each event is sent immediately, so the user can see the partial responses as they are generated.

There are no silent failures.  If the Agent is down or fails before it streams, the Gateway returns an HTTP 502 error.  If an external provider fails while the answer is already streaming, the Agent ends the run with `terminated: "error"`, and sends a 502 as an SSE `error` event.  A tool failure that can still be continued by the loop, such as a request that returns 403, is recorded as a trace with `ok: false` with the error message, while the Agent continues working.  Reaching a tool-call or time cap is not an error.  The Agent stops with `terminated: "cap"`, and a best partial answer.

When a document is uploaded, the original file is stored in MongoDB GridFS, a document with pending status is created, and a job is added to the jobs list.  It returns `202 {docId, status: "pending"}` in under 300 ms.  A background worker picks up the job, and changes it from pending to running.  It uses an atomic MongoDB operation called `findOneAndUpdate`, so only one worker can take the job.  The job records `claimedAt` and `workerId`.

The browser shows progress by repeatedly calling GET /spaces/{id}/documents.  This process is called polling.  If there are no available workers, the jobs stay as pending.  If the job stops mid-run, the row stays `running`, but its `claimedAt` becomes stale.  A sweeper periodically checks for these jobs, and returns them to pending, so another worker can claim the job without repeating what has been done before.

## State

Lumina uses MongoDB Atlas as its database that stores the system's authoritative data, which means the data that Lumina treats as source of truth.  Every user-owned document in MongoDB carries the user id.  `threads` and `messages` store conversations.  Each AI message stores the answer, its sources, its `done` metrics.  For deep research, it also keeps the plan, so any old answer can be explained.

`memories` stores facts about the user.  These memories also have embeddings, which allow Lumina to find relevant memories using vector search.  The vector search is filtered by userId.  A memory is only written when the Agent calls `save_memory`.  Memories can be listed with `GET /memory`, and removed with `DELETE /memory/{id}`.  Lumina cannot remember something that the user cannot see or delete.

For uploaded files, `spaces` organizes documents, and `documents` store metadata, and its status (pending -> parsing -> embedding -> indexed, or failed, with a percentage).  The original uploaded file is stored in GridFS.  The document is divided into chunks, and `chunks` keeps each chunk's text, locator (page for PDF, heading or line for text), and embedding.  All Spaces use `chunks`, so `$vectorSearch` can use `spaceId` as a filter to make sure it searches only the correct Space.  As the text, locator, and embedding are all in the same chunk document, Lumina can retrieve a chunk, and know where it came from for its citation, without joining separate stores.

`jobs` is the durable ingestion queue.  Durable means the jobs are stored in MongoDB.

`requests` and `runs` are the durable record of the requests and answers.  The `/stats` numbers must reconcile with the logs, so I will compute `/stats` from these records.

`/stats` is calculated from the run logs (today's `runs` rows) instead of keeping separate counters.  Two records of the same thing can drift apart: a counter could go up while a log write fails, or reset when the Agent restarts.  Adding up the logs means `/stats` always agrees with them, which the benchmark checks: in my test both showed 56 answers and $0.348.  The cost is a small database query each time `/stats` is opened, which is fine at this scale.

A document that is being stored in MongoDB is not automatically searchable.  Since Atlas Search is eventually consistent, which means that there can be a short delay between writing a chunk to MongoDB, and that chunk becoming available to vector search.  The worker does a read-your-write probe, which searches the vector index to retrieve a chunk that it just wrote.  It marks that the document is indexed only after this succeeds.  If processing fails, it marks the document `failed` with an error instead of indexing a half-indexed document.

The search cache has two tiers for external search results:
1. An in-memory LRU cache inside each Agent process, which is very fast, but disappears when that process restarts
2. The MongoDB `searchCache` collection, which survives restarts

Cache entries are identified by a SHA-256 of the normalized query and search provider, and MongoDB uses a TTL index to automatically make them expired after 6 hours by default (set by `SEARCH_CACHE_TTL_SECONDS`).  If both caches are deleted, Lumina still works correctly, but it is more expensive and slower because it has to perform the searches again.  Lumina caches only the search results, and not the final answer.

Run logs (`runs/<requestId>.json` locally, the `runs` collection when deployed) record how each AI run behaved, including tokens, wall-clock-time, cost, `depth` (quick or deep), how the run `terminated`, and every tool call whether it succeeded or failed.  These logs are not part of the user's actual product data.  They are evidence used by Lumina's quality gates to check if the system is behaving correctly.

The rate limit (30 per minute per user) only counts the requests that cost money: asking a question (LLM + search) and uploading a file (embeddings).  Reading threads, memories or document status is free and is not counted.  The UI checks upload progress every 1.5 seconds, so counting everything would block users with 429 errors just for watching their upload.  The counter lives in the gateway's memory, which is fast and correct for one gateway.  With two gateways each keeps its own count, so a user could get 60 per minute.  If I scale out, I would move the counter to MongoDB or Redis so all gateways share it.

The deep-search daily cap (5 per user) is enforced in the Agent, not the Gateway, because a cap belongs next to the spending: anything that reaches the Agent without going through the Gateway would skip a Gateway cap.  The day resets at midnight UTC, which is the `resetsAt` time in the 429.  A deep search counts the moment it starts, not when it finishes, because a run that fails half-way has already spent money.  Counting at the start also means six searches started at the same instant cannot all get through: in my test, six at once against a cap of 2 let exactly two in.

## Trade-offs

The Gateway and Agent are separate as a requirement of the assignment.  The main benefit is security.  The Gateway can communicate with the browser, while sensitive things, such as provider API keys, and the spend cap stay inside the private Agent, where the browser cannot reach them.  The tradeoff is complexity.  Every request has to make an extra network hop from Browser -> Gateway -> Agent.  We have to deploy two services, and if the Agent goes down, the Gateway has to return a 502 error.  A single backend service would be simpler, but it would not provide the same security.

Instead of adding a separate vector database, Atlas Vector Search keeps text, embedding, and page locator in one document, so when Lumina finds a chunk using vector search, it already has the information needed to create its citation.  However, Lumina has to work within the limits of the MongoDB Atlas M0 tier, with three search index limit, and 512 MB storage limit.  Again, Atlas Vector Search is eventually consistent, so newly stored chunks may not immediately appear to search.

The trade-off for having two-tier search cache is not clear.  There are now two caches to keep consistent.  The MongoDB searchCache is clearly useful, because it survives restarts and is shared by all Agent instances.  I am not sure how much the in-process LRU adds, because each LRU only helps its own process, so with many Agent instances it helps less.  Both tiers are required, so I will keep both.

Quick search follows a small fixed plan instead of an open loop: one web search, one round of 2–4 pages read in parallel, and one document search (a second only if the first found nothing), in at most two model turns.  With the open loop, the model sometimes searched the same documents seven times in a row until the 8-call cap stopped it, so 13 of 102 deployed runs ended as `cap` instead of `done`.  Reworded extra searches also missed the search cache on repeated questions (35% hit rate against a 50% target).  With the plan, a local test had 0 of 9 runs capped, answer p95 fell from 15.6 s to 9.0 s, and cost per quick answer from $0.0038 to $0.0017.  The trade-off: a quick answer cannot notice weak results and dig further on its own.  Deep search is where that happens, and a follow-up question is how a user asks for more.

I did not add a re-rank step.  Hybrid search (vector + BM25, merged with RRF) already finds the right page in the top 5 for 29 of the 30 gold questions (recall@5 = 0.967, target 0.70).  A re-rank would add a model call to every question, making answers slower and more expensive, to fix at most one miss, and that miss came from the model rewording the question, not from bad ranking.  I would add re-ranking if recall@5 dropped below 0.70.
