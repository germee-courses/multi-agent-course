/**
 * The jobs worker: its own process (`npm run worker`), so a 60-page PDF is parsed here and
 * never on the thread that is streaming somebody's answer.
 *
 *   loop: sweep stale jobs → claim one atomically → index it → mark the job done / failed
 *
 * index_document → GridFS read → parse (pdfjs-dist, page-aware) → chunk → embed →
 *                  upsert into chunks → READ-YOUR-WRITE PROBE → status: 'indexed'
 *
 * The claim is one findOneAndUpdate, so two workers can never take the same job. A worker
 * killed mid-job leaves the row `running` with a stale claimedAt; the sweeper returns it to
 * `pending` (or fails it, once it has crashed JOB_MAX_ATTEMPTS workers).
 *
 * Finished stages are not re-run: chunk ids are `<docId>_<ord>`, parsing is deterministic,
 * so a retry re-parses (cheap) but only embeds the chunks that are not already stored.
 *
 * "Upserted" is not "searchable": Atlas Search indexes are eventually consistent, so the
 * probe (query the vector index for a chunk we just wrote, get it back) is what earns
 * `indexed`. Deep search does NOT run here; it streams over SSE like a quick answer.
 */
import { hostname } from 'node:os';
import { GridFSBucket, ObjectId } from 'mongodb';
import pino from 'pino';
import {
  COLLECTIONS,
  GRIDFS_BUCKETS,
  SEARCH_INDEXES,
  type ChunkDoc,
  type DocStatus,
  type DocumentDoc,
  type JobDoc
} from '@lumina/contract';
import { env } from './env.js';
import { db } from './db.js';
import { parseAndChunk } from './ingest.js';
import { embedMany } from './memory.js';

const log = pino({ level: env.logLevel });
const workerId = `${hostname()}-${process.pid}`;
const SWEEP_EVERY_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collections() {
  const database = await db();
  return {
    database,
    jobs: database.collection<JobDoc>(COLLECTIONS.jobs),
    documents: database.collection<DocumentDoc>(COLLECTIONS.documents),
    chunks: database.collection<ChunkDoc>(COLLECTIONS.chunks)
  };
}

// ---------------------------------------------------------------- claim + sweep

async function claim(): Promise<JobDoc | null> {
  const { jobs } = await collections();
  return jobs.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

/** Return crashed jobs to the queue; fail the ones that keep crashing workers. */
async function sweep(): Promise<void> {
  const { jobs, documents } = await collections();
  const staleBefore = new Date(Date.now() - env.jobStaleSec * 1000);
  const stale = await jobs.find({ status: 'running', claimedAt: { $lt: staleBefore } }).toArray();
  for (const job of stale) {
    if (job.attempts >= env.jobMaxAttempts) {
      const error = `gave up after ${job.attempts} attempts (worker died each time)`;
      // Guarded on claimedAt so a worker that came back to life is not overwritten.
      const res = await jobs.updateOne(
        { _id: job._id, status: 'running', claimedAt: job.claimedAt },
        { $set: { status: 'failed', error } }
      );
      if (res.modifiedCount) {
        await documents.updateOne({ _id: String(job.payload.docId) }, { $set: { status: 'failed', error } });
        log.warn({ jobId: job._id, attempts: job.attempts }, 'job failed by sweeper');
      }
    } else {
      const res = await jobs.updateOne(
        { _id: job._id, status: 'running', claimedAt: job.claimedAt },
        { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
      );
      if (res.modifiedCount) log.warn({ jobId: job._id, deadWorker: job.workerId }, 'stale job returned to pending');
    }
  }
}

// ---------------------------------------------------------------- index_document

/**
 * Move the document forward and refresh the job's claimedAt: a long, healthy job is a
 * heartbeat away from ever looking stale to the sweeper.
 */
async function progress(job: JobDoc, docId: string, status: DocStatus, pct: number, extra: Partial<DocumentDoc> = {}) {
  const { jobs, documents } = await collections();
  await documents.updateOne({ _id: docId }, { $set: { status, pct, ...extra } });
  await jobs.updateOne({ _id: job._id, workerId }, { $set: { claimedAt: new Date() } });
}

async function readUpload(fileId: string): Promise<Buffer> {
  const { database } = await collections();
  const bucket = new GridFSBucket(database, { bucketName: GRIDFS_BUCKETS.uploads });
  const parts: Buffer[] = [];
  for await (const part of bucket.openDownloadStream(new ObjectId(fileId))) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

async function indexDocument(job: JobDoc): Promise<void> {
  const { documents, chunks } = await collections();
  const docId = String(job.payload.docId);
  const doc = await documents.findOne({ _id: docId });
  if (!doc) throw new Error(`document ${docId} no longer exists`);
  // A worker that died between "indexed" and "job done" left nothing to redo.
  if (doc.status === 'indexed') return;

  const t0 = Date.now();
  await progress(job, docId, 'parsing', 5);
  const parsed = await parseAndChunk(await readUpload(doc.fileId), doc.mimeType);
  if (!parsed.chunks.length) {
    throw new Error(doc.mimeType === 'application/pdf' ? 'no text found (is this a scanned PDF?)' : 'the file is empty');
  }
  const tParsed = Date.now();
  await progress(job, docId, 'embedding', 15, parsed.pages ? { pages: parsed.pages } : {});

  // Resume: chunks a previous attempt already stored are not embedded (or paid for) again.
  const ids = parsed.chunks.map((_, ord) => `${docId}_${ord}`);
  const done = new Set(
    (await chunks.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((c) => c._id)
  );
  let tokens = 0;
  for (let from = 0; from < ids.length; from += env.embedBatchSize) {
    const batch = ids.slice(from, from + env.embedBatchSize).map((id, i) => ({ id, ord: from + i }))
      .filter(({ id }) => !done.has(id));
    if (batch.length) {
      const res = await embedMany(batch.map(({ ord }) => parsed.chunks[ord]!.text));
      tokens += res.tokens;
      await chunks.bulkWrite(
        batch.map(({ id, ord }, i) => ({
          replaceOne: {
            filter: { _id: id },
            replacement: {
              _id: id,
              docId: doc._id,
              spaceId: doc.spaceId,
              userId: doc.userId,
              text: parsed.chunks[ord]!.text,
              locator: parsed.chunks[ord]!.locator,
              ord,
              embedding: res.vectors[i]!,
              createdAt: new Date()
            },
            upsert: true
          }
        }))
      );
    }
    const embedded = Math.min(from + env.embedBatchSize, ids.length);
    await progress(job, docId, 'embedding', 15 + Math.round((75 * embedded) / ids.length));
  }
  // A re-uploaded or re-parsed document may have fewer chunks than a previous attempt.
  await chunks.deleteMany({ docId: doc._id, ord: { $gte: ids.length } });
  const tEmbedded = Date.now();

  await progress(job, docId, 'embedding', 95);
  await probe(doc, ids[ids.length - 1]!);
  await progress(job, docId, 'indexed', 100, { chunks: ids.length });

  log.info(
    {
      docId,
      title: doc.title,
      chunks: ids.length,
      pages: parsed.pages,
      reused: done.size,
      embedTokens: tokens,
      parseMs: tParsed - t0,
      embedMs: tEmbedded - tParsed,
      probeMs: Date.now() - tEmbedded
    },
    'document indexed'
  );
}

/**
 * Read-your-write: search the vector index with a chunk's own embedding, inside its Space,
 * until that chunk comes back. Until it does, the document is not searchable, whatever
 * `chunks` says. The local-dev cosine scan reads the collection directly, so it is
 * consistent as soon as the write returns.
 */
async function probe(doc: DocumentDoc, chunkId: string): Promise<void> {
  const { chunks } = await collections();
  const chunk = await chunks.findOne({ _id: chunkId });
  if (!chunk) throw new Error(`probe: chunk ${chunkId} was not written`);
  if (env.vectorBackend === 'mongo-cosine-scan') return;

  const deadline = Date.now() + env.probeTimeoutSec * 1000;
  for (let attempt = 1; ; attempt++) {
    const hits = await chunks
      .aggregate<{ _id: string }>([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.chunksVector,
            path: 'embedding',
            queryVector: chunk.embedding,
            filter: { spaceId: doc.spaceId, userId: doc.userId },
            numCandidates: 100,
            limit: 10
          }
        },
        { $project: { _id: 1 } }
      ])
      .toArray();
    if (hits.some((h) => h._id === chunkId)) {
      log.debug({ docId: doc._id, attempt }, 'probe found the chunk');
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`not searchable after ${env.probeTimeoutSec}s: the vector index never returned ${chunkId}`);
    }
    await sleep(Math.min(500 * attempt, 3000));
  }
}

// ---------------------------------------------------------------- the loop

async function runJob(job: JobDoc): Promise<void> {
  const { jobs, documents } = await collections();
  try {
    if (job.kind !== 'index_document') throw new Error(`unknown job kind ${job.kind}`);
    await indexDocument(job);
    await jobs.updateOne({ _id: job._id, workerId }, { $set: { status: 'done' }, $unset: { error: '' } });
  } catch (err) {
    // Fail loud: the document says `failed` with the reason, never a silent `pending`.
    const error = (err instanceof Error ? err.message : String(err)).trim() || 'indexing failed';
    log.error({ jobId: job._id, docId: job.payload.docId, err }, 'job failed');
    await jobs.updateOne({ _id: job._id, workerId }, { $set: { status: 'failed', error } });
    await documents.updateOne({ _id: String(job.payload.docId) }, { $set: { status: 'failed', error } });
  }
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Finish the current job rather than leave it for the sweeper; a second signal exits now.
    if (stopping) process.exit(1);
    stopping = true;
    log.info('stopping after the current job');
  });
}

async function main(): Promise<void> {
  log.info({ workerId, pollMs: env.workerPollMs, staleSec: env.jobStaleSec }, 'jobs worker up');
  let lastSweep = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
        await sweep();
        lastSweep = Date.now();
      }
      const job = await claim();
      if (!job) {
        await sleep(env.workerPollMs);
        continue;
      }
      log.info({ jobId: job._id, docId: job.payload.docId, attempt: job.attempts }, 'claimed');
      await runJob(job);
    } catch (err) {
      // The database itself is unreachable: say so, back off, keep trying.
      log.error({ err }, 'worker loop error');
      await sleep(5000);
    }
  }
  process.exit(0);
}

void main();
