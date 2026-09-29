import {
  COLLECTIONS,
  SEARCH_INDEXES,
  type ChunkDoc,
  type DocumentDoc,
  type Locator
} from '@lumina/contract';
import { env } from '../env.js';
import { db } from '../db.js';
import { embed } from '../memory.js';
import { ProviderError } from './search.js';

/**
 * search_documents: hybrid retrieval over ONE Space.
 *
 *   dense   $vectorSearch on chunks.embedding   finds meaning ("car" ≈ "automobile")
 *   sparse  $search (BM25) on chunks.text       finds exact rare words ("k1", "0.75")
 *   fuse    reciprocal rank fusion: score = Σ 1/(rrfK + rank) over the lists a chunk is in
 *   gate    drop anything whose similarity to the question is under docMinVectorScore
 *
 * RRF fuses ranks, not scores, on purpose: BM25 scores are unbounded and corpus-dependent,
 * cosine is bounded, and adding them is meaningless. Ranks are comparable.
 *
 * No re-rank step. The Space is small (a few documents, tens of chunks), RRF over two
 * retrievers is the measured baseline, and a cross-encoder or LLM re-rank would add a
 * model call to a first-token time that is already over budget. Revisit if recall@5 on
 * the gold set falls under 0.70.
 *
 * Both retrievers filter by spaceId AND userId INSIDE the search stage, so another
 * Space's chunks are never even candidates.
 */

export interface DocHit {
  chunkId: string;
  docId: string;
  title: string;
  text: string;
  locator: Locator;
  /** Similarity to the question, Atlas's (1 + cos) / 2. */
  similarity: number;
  rrf: number;
  /** Which retrievers found it: what makes a fusion result explainable in the trace. */
  via: ('vector' | 'bm25')[];
}

type Candidate = Pick<ChunkDoc, '_id' | 'docId' | 'text' | 'locator' | 'embedding'>;

async function chunks() {
  return (await db()).collection<ChunkDoc>(COLLECTIONS.chunks);
}

export async function searchDocuments(
  spaceId: string,
  userId: string,
  query: string
): Promise<{ hits: DocHit[]; embeddingTokens: number }> {
  if (env.vectorBackend !== 'atlas-vector-search') {
    throw new ProviderError('documents', `VECTOR_BACKEND=${env.vectorBackend} is not implemented; use atlas-vector-search`);
  }
  const { vector, tokens } = await embed(query);
  const coll = await chunks();
  const project = { $project: { _id: 1, docId: 1, text: 1, locator: 1, embedding: 1 } };

  const [dense, sparse] = await Promise.all([
    coll
      .aggregate<Candidate>([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.chunksVector,
            path: 'embedding',
            queryVector: vector,
            filter: { spaceId, userId },
            numCandidates: env.docCandidates * 5,
            limit: env.docCandidates
          }
        },
        project
      ])
      .toArray(),
    coll
      .aggregate<Candidate>([
        {
          $search: {
            index: SEARCH_INDEXES.chunksText,
            compound: {
              must: [{ text: { query, path: 'text' } }],
              filter: [
                { equals: { path: 'spaceId', value: spaceId } },
                { equals: { path: 'userId', value: userId } }
              ]
            }
          }
        },
        { $limit: env.docCandidates },
        project
      ])
      .toArray()
  ]);

  // ------------------------------------------------------------- fuse
  const fused = new Map<string, { c: Candidate; rrf: number; via: DocHit['via'] }>();
  const add = (list: Candidate[], name: 'vector' | 'bm25') =>
    list.forEach((c, i) => {
      const row = fused.get(c._id) ?? { c, rrf: 0, via: [] };
      row.rrf += 1 / (env.rrfK + i + 1);
      row.via.push(name);
      fused.set(c._id, row);
    });
  add(dense, 'vector');
  add(sparse, 'bm25');

  // ------------------------------------------------------------- gate + dedupe + top-k
  // The same file uploaded twice yields identical passages; five copies of one paragraph
  // is one result, not five, so only the best-ranked copy is kept.
  const seen = new Set<string>();
  const ranked = [...fused.values()]
    .map((r) => ({ ...r, similarity: (1 + cosine(vector, r.c.embedding)) / 2 }))
    .filter((r) => r.similarity >= env.docMinVectorScore)
    .sort((a, b) => b.rrf - a.rrf)
    .filter((r) => {
      const key = r.c.text.replace(/\s+/g, ' ').trim().toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .slice(0, env.docTopK);

  const titles = await docTitles(ranked.map((r) => r.c.docId));
  return {
    embeddingTokens: tokens,
    hits: ranked.map((r) => ({
      chunkId: r.c._id,
      docId: r.c.docId,
      title: titles.get(r.c.docId) ?? r.c.docId,
      text: r.c.text,
      locator: r.c.locator,
      similarity: round(r.similarity),
      rrf: round(r.rrf),
      via: r.via
    }))
  };
}

/** What the router shows the model: which files this Space holds, and whether they are ready. */
export async function spaceContents(spaceId: string, userId: string): Promise<{ indexed: string[]; notReady: string[] }> {
  const docs = await (await db())
    .collection<DocumentDoc>(COLLECTIONS.documents)
    .find({ spaceId, userId }, { projection: { title: 1, status: 1 } })
    .toArray();
  return {
    indexed: [...new Set(docs.filter((d) => d.status === 'indexed').map((d) => d.title))],
    notReady: [...new Set(docs.filter((d) => d.status !== 'indexed').map((d) => d.title))]
  };
}

async function docTitles(docIds: string[]): Promise<Map<string, string>> {
  if (!docIds.length) return new Map();
  const rows = await (await db())
    .collection<DocumentDoc>(COLLECTIONS.documents)
    .find({ _id: { $in: [...new Set(docIds)] } }, { projection: { title: 1 } })
    .toArray();
  return new Map(rows.map((d) => [d._id, d.title]));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
