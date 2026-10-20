// Per-invocation Drizzle client (R4: no long-held pools; connection-per-invocation).
// Uses postgres.js over TCP. Neon HTTP driver is a drop-in alternative if S4 burst test shows
// connection storms — decided by spike S4 (tech.md §7).

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

let db: Db | null = null;
let client: ReturnType<typeof postgres> | null = null;

export function getDb(): Db {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  client = postgres(url, {
    max: 1, // serverless: one connection per invocation, released quickly
    idle_timeout: 20,
    connect_timeout: 10,
  });
  db = drizzle(client, { schema });
  return db;
}
