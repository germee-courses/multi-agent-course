import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { GridFSBucket } from 'mongodb';
import {
  COLLECTIONS,
  GRIDFS_BUCKETS,
  newId,
  type DocumentDoc,
  type JobDoc,
  type ListDocumentsResponse,
  type ListSpacesResponse,
  type SpaceDoc
} from '@lumina/contract';
import { db } from './db.js';

/**
 * Spaces and the upload half of ingestion. The request path does only the cheap, durable
 * part — store the raw file in GridFS, insert a `pending` document and its `jobs` row —
 * and returns 202. Parsing, chunking and embedding belong to the worker (worker.ts), so
 * a 60-page PDF never blocks the thread that is streaming someone's answer.
 *
 * Like threads, a Space is always looked up by (id, userId): another user's Space is
 * simply "not found".
 */

/** What we accept, by MIME type or, when the client sends a vague one, by extension. */
const TYPES_BY_EXT: Record<string, DocumentDoc['mimeType']> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain'
};
const ACCEPTED = new Set(Object.values(TYPES_BY_EXT));

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

async function spaces() {
  return (await db()).collection<SpaceDoc>(COLLECTIONS.spaces);
}
async function documents() {
  return (await db()).collection<DocumentDoc>(COLLECTIONS.documents);
}
async function jobs() {
  return (await db()).collection<JobDoc>(COLLECTIONS.jobs);
}
const iso = (d: string | Date) => new Date(d).toISOString();

export async function createSpace(userId: string, name: string): Promise<{ spaceId: string; name: string }> {
  const spaceId = newId('spc');
  await (await spaces()).insertOne({ _id: spaceId, userId, name, createdAt: new Date() });
  return { spaceId, name };
}

export async function listSpaces(userId: string): Promise<ListSpacesResponse> {
  const rows = await (await spaces()).find({ userId }).sort({ createdAt: -1 }).toArray();
  return { spaces: rows.map((s) => ({ spaceId: s._id, name: s.name, createdAt: iso(s.createdAt) })) };
}

export async function findSpace(spaceId: string, userId: string): Promise<SpaceDoc | null> {
  return (await spaces()).findOne({ _id: spaceId, userId });
}

/** The file's real type, or null if LUMINA does not read it. curl sends octet-stream for .md. */
export function acceptedType(file: Pick<UploadedFile, 'originalname' | 'mimetype'>): string | null {
  if (ACCEPTED.has(file.mimetype)) return file.mimetype;
  return TYPES_BY_EXT[extname(file.originalname).toLowerCase()] ?? null;
}

/**
 * Store the file and the `pending` document side by side, then its job. Returns as soon as
 * all three are committed; nothing here reads the file's contents.
 *
 * The 202 has a 300 ms budget and every write is a round trip to Atlas, so the two that do
 * not depend on each other run in parallel: GridFS assigns the file's id when the stream
 * OPENS, so the document can name it before a byte is written. The job goes last, because
 * the worker that claims it needs both the file and the document to exist.
 */
export async function uploadDocument(space: SpaceDoc, file: UploadedFile, mimeType: string): Promise<string> {
  const database = await db();
  const docId = newId('doc');

  const bucket = new GridFSBucket(database, { bucketName: GRIDFS_BUCKETS.uploads });
  const stream = bucket.openUploadStream(file.originalname, {
    metadata: { docId, spaceId: space._id, userId: space.userId, mimeType }
  });
  const writeFile = new Promise<void>((resolve, reject) => {
    stream.once('finish', () => resolve());
    stream.once('error', reject);
    stream.end(file.buffer);
  });
  const insertDocument = (async () =>
    (await documents()).insertOne({
      _id: docId,
      spaceId: space._id,
      userId: space.userId,
      title: file.originalname,
      mimeType,
      bytes: file.size,
      status: 'pending',
      pct: 0,
      fileId: stream.id.toString(),
      createdAt: new Date()
    }))();

  const [fileWrite, docWrite] = await Promise.allSettled([writeFile, insertDocument]);
  if (fileWrite.status === 'rejected' || docWrite.status === 'rejected') {
    const err = fileWrite.status === 'rejected' ? fileWrite.reason : (docWrite as PromiseRejectedResult).reason;
    // If the row made it but the file did not, the row must not sit at `pending` forever.
    if (docWrite.status === 'fulfilled') {
      await (await documents()).updateOne(
        { _id: docId },
        { $set: { status: 'failed', error: `upload failed: ${(err as Error).message}` } }
      );
    }
    throw err;
  }

  try {
    await (await jobs()).insertOne({
      _id: `job_${randomUUID()}`,
      kind: 'index_document',
      status: 'pending',
      payload: { docId },
      userId: space.userId,
      attempts: 0,
      createdAt: new Date()
    });
  } catch (err) {
    // A document with no job would say `pending` forever. Say what happened instead.
    await (await documents()).updateOne(
      { _id: docId },
      { $set: { status: 'failed', error: `could not queue indexing: ${(err as Error).message}` } }
    );
    throw err;
  }
  return docId;
}

export async function listDocuments(spaceId: string, userId: string): Promise<ListDocumentsResponse> {
  const rows = await (await documents()).find({ spaceId, userId }).sort({ createdAt: -1 }).toArray();
  return {
    documents: rows.map((d) => ({
      docId: d._id,
      title: d.title,
      status: d.status,
      pct: d.pct,
      ...(d.pages ? { pages: d.pages } : {}),
      ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
      ...(d.error ? { error: d.error } : {})
    }))
  };
}
