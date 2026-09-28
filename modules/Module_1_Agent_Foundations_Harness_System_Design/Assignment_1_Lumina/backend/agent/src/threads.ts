import { randomUUID } from 'node:crypto';
import {
  COLLECTIONS,
  newId,
  type DoneEvent,
  type GetThreadResponse,
  type ListThreadsResponse,
  type MessageDoc,
  type Source,
  type ThreadDoc
} from '@lumina/contract';
import { db } from './db.js';

/**
 * Thread memory: every question and every answer, persisted, so a follow-up sees the
 * conversation. Threads are always looked up by (id, userId): one user can never read or
 * append to another user's thread, and an unknown id is simply "not found".
 */

/** How much of the thread a follow-up sees. Enough for "it" and "that one"; not a transcript. */
const HISTORY_MESSAGES = 6;
const HISTORY_CHARS_PER_MESSAGE = 1_500;
const DEFAULT_TITLE = 'New thread';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

async function threads() {
  return (await db()).collection<ThreadDoc>(COLLECTIONS.threads);
}
async function messages() {
  return (await db()).collection<MessageDoc>(COLLECTIONS.messages);
}
const iso = (d: string | Date) => new Date(d).toISOString();

export async function createThread(userId: string, title?: string): Promise<string> {
  const threadId = newId('thr');
  await (await threads()).insertOne({ _id: threadId, userId, title: title ?? DEFAULT_TITLE, createdAt: new Date() });
  return threadId;
}

export async function findThread(threadId: string, userId: string): Promise<ThreadDoc | null> {
  return (await threads()).findOne({ _id: threadId, userId });
}

export async function listThreads(userId: string): Promise<ListThreadsResponse> {
  const rows = await (await threads()).find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();
  return { threads: rows.map((t) => ({ threadId: t._id, title: t.title, createdAt: iso(t.createdAt) })) };
}

export async function getThread(thread: ThreadDoc): Promise<GetThreadResponse> {
  const rows = await (await messages()).find({ threadId: thread._id, userId: thread.userId }).sort({ createdAt: 1 }).toArray();
  return {
    threadId: thread._id,
    title: thread.title,
    messages: rows.map((m) => ({
      role: m.role,
      content: m.content,
      sources: m.sources,
      answerId: m.answerId,
      done: m.done,
      createdAt: iso(m.createdAt)
    }))
  };
}

/**
 * The last few turns, oldest first, for the loop. Old answers keep their text but lose
 * their [n] markers: those numbers belonged to THAT answer's sources, and left in, the
 * model would happily cite "[2]" meaning a page this request never retrieved.
 */
export async function loadHistory(threadId: string, userId: string): Promise<Turn[]> {
  const rows = await (await messages())
    .find({ threadId, userId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_MESSAGES)
    .toArray();
  return rows.reverse().map((m) => ({
    role: m.role,
    content: m.content.replace(/\[\d{1,3}\]/g, '').slice(0, HISTORY_CHARS_PER_MESSAGE)
  }));
}

export async function saveUserMessage(thread: ThreadDoc, content: string): Promise<void> {
  await (await messages()).insertOne({
    _id: `msg_${randomUUID()}`,
    threadId: thread._id,
    userId: thread.userId,
    role: 'user',
    content,
    sources: [],
    createdAt: new Date()
  });
  // A thread is named after its first question, so the thread list is readable.
  if (thread.title === DEFAULT_TITLE) {
    await (await threads()).updateOne({ _id: thread._id }, { $set: { title: content.slice(0, 80) } });
  }
}

export async function saveAnswer(
  thread: ThreadDoc,
  answer: { content: string; sources: Source[]; done: DoneEvent }
): Promise<void> {
  await (await messages()).insertOne({
    _id: `msg_${randomUUID()}`,
    threadId: thread._id,
    userId: thread.userId,
    role: 'assistant',
    content: answer.content,
    answerId: answer.done.answerId,
    sources: answer.sources,
    done: answer.done,
    createdAt: new Date()
  });
}
