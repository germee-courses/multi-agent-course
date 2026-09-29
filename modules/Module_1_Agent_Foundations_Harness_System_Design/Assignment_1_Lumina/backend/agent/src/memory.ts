import OpenAI from 'openai';
import {
  COLLECTIONS,
  SEARCH_INDEXES,
  newId,
  type ListMemoryResponse,
  type MemoryDoc
} from '@lumina/contract';
import { env, secrets } from './env.js';
import { db } from './db.js';
import { ProviderError } from './tools/search.js';

/**
 * Long-term memory: durable facts and preferences about ONE user, carried into every
 * thread. Three rules:
 *
 *   - Written only by an explicit save_memory call, which shows up in the trace.
 *   - Recalled semantically: Atlas Vector Search on `embedding`, with userId as a filter
 *     INSIDE $vectorSearch, so another user's memories are never even candidates.
 *   - Nothing is remembered that GET /memory does not list. Delete a row and it is gone
 *     from recall too, because recall reads the same collection.
 *
 * Embedding failures throw (fail loud): a recall that silently returned [] would look
 * exactly like "this user has no memories".
 */

/** Cap on what one answer is told about the user (~10 docs / 1 000 tokens in the spec). */
const RECALL_LIMIT = 5;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!secrets.openai) throw new ProviderError('openai', 'OPENAI_API_KEY is not set');
  client ??= new OpenAI({ apiKey: secrets.openai });
  return client;
}

async function memories() {
  return (await db()).collection<MemoryDoc>(COLLECTIONS.memories);
}

/** One embedding, and the tokens it cost (so the answer's costUsd includes it). */
export async function embed(text: string): Promise<{ vector: number[]; tokens: number }> {
  const res = await openai().embeddings.create({ model: env.embeddingModel, input: text });
  const vector = res.data[0]?.embedding;
  if (!vector) throw new ProviderError('openai', 'embedding response had no vector');
  return { vector, tokens: res.usage?.prompt_tokens ?? 0 };
}

/** Many embeddings in one call (the worker's batch path). Order matches `texts`. */
export async function embedMany(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const res = await openai().embeddings.create({ model: env.embeddingModel, input: texts });
  const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new ProviderError('openai', `asked for ${texts.length} embeddings, got ${vectors.length}`);
  }
  return { vectors, tokens: res.usage?.prompt_tokens ?? 0 };
}

export interface RecalledMemory {
  id: string;
  text: string;
  score: number;
}

export async function recallMemory(
  userId: string,
  query: string
): Promise<{ memories: RecalledMemory[]; tokens: number }> {
  // Most users have no memories yet; skip the embedding call for them.
  if (!(await (await memories()).countDocuments({ userId }, { limit: 1 }))) {
    return { memories: [], tokens: 0 };
  }
  const { vector, tokens } = await embed(query);
  const rows = await (await memories())
    .aggregate<RecalledMemory>([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.memoriesVector,
          path: 'embedding',
          queryVector: vector,
          filter: { userId },
          numCandidates: 50,
          limit: RECALL_LIMIT
        }
      },
      { $project: { _id: 0, id: '$_id', text: 1, score: { $meta: 'vectorSearchScore' } } }
    ])
    .toArray();
  return { memories: rows, tokens };
}

export async function saveMemory(
  userId: string,
  text: string,
  sourceThread?: string
): Promise<{ id: string; duplicate: boolean; tokens: number }> {
  const clean = text.replace(/\s+/g, ' ').trim();
  // Saying the same thing twice should not create two rows to delete.
  const existing = await (await memories()).findOne({ userId, text: clean });
  if (existing) return { id: existing._id, duplicate: true, tokens: 0 };

  const { vector, tokens } = await embed(clean);
  const id = newId('mem');
  await (await memories()).insertOne({
    _id: id,
    userId,
    text: clean,
    embedding: vector,
    sourceThread: sourceThread as MemoryDoc['sourceThread'],
    createdAt: new Date()
  });
  return { id, duplicate: false, tokens };
}

export async function listMemories(userId: string): Promise<ListMemoryResponse> {
  const rows = await (await memories())
    .find({ userId }, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return {
    memories: rows.map((m) => ({
      id: m._id,
      text: m.text,
      sourceThread: m.sourceThread,
      createdAt: new Date(m.createdAt).toISOString()
    }))
  };
}

/** true if a row was deleted; false if there was no such memory for this user. */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const res = await (await memories()).deleteOne({ _id: id, userId });
  return res.deletedCount === 1;
}
