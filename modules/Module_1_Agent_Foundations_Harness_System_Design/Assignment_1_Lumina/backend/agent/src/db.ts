import { MongoClient, type Db } from 'mongodb';
import { env } from './env.js';

let client: MongoClient | null = null;

/** One client per process. The driver pools connections; do not open one per request. */
export async function db(): Promise<Db> {
  if (!env.mongoUri) throw new Error('MONGODB_URI is not set — copy .env.example to .env');
  if (!client) {
    // Cache the client only once it has connected: a failed first connect would otherwise
    // leave a closed client here, and every later call fails with "Topology is closed"
    // even after the network comes back.
    const fresh = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
    await fresh.connect();
    client = fresh;
  }
  return client.db(env.mongoDb);
}

export async function pingDb(): Promise<'ok' | 'down'> {
  try {
    await (await db()).command({ ping: 1 });
    return 'ok';
  } catch {
    return 'down';
  }
}
