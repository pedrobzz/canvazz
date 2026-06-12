import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'

/**
 * Embedded libSQL database. Lives at ~/.canvazz/database.db (override with
 * CANVAZZ_DB, e.g. for tests) — no daemon, the server process opens the file
 * directly. Kept on globalThis so Vite dev module reloads reuse the handle.
 */

async function open(): Promise<Client> {
  const path = process.env.CANVAZZ_DB ?? join(homedir(), '.canvazz', 'database.db')
  mkdirSync(dirname(path), { recursive: true })
  const client = createClient({ url: `file:${path}` })
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      doc TEXT NOT NULL,
      thumbnail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return client
}

/** Schema-ready database handle; `await db()` before querying. */
export function db(): Promise<Client> {
  return ((globalThis as Record<string, unknown>).__czDb ??= open()) as Promise<Client>
}
