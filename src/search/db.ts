import { createClient, type Client } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDb(latDir: string): Client {
  const cacheDir = join(latDir, '.cache');
  mkdirSync(cacheDir, { recursive: true });

  const client = createClient({
    url: `file:${join(cacheDir, 'vectors.db')}`,
  });

  return client;
}

/** Create the `meta` key/value table if absent. */
export async function ensureMeta(db: Client): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
}

/**
 * The embedding backend this index was built with, e.g. `local:minilm-l6-v2:384`
 * or `openai:1536`. This record is *authoritative*: it governs which backend
 * `lat search` uses. Null when the index has never been built.
 */
export async function getStoredModel(db: Client): Promise<string | null> {
  const rows = await db.execute(
    "SELECT value FROM meta WHERE key = 'embedding_model'",
  );
  return (rows.rows[0]?.value as string | undefined) ?? null;
}

export async function setStoredModel(db: Client, value: string): Promise<void> {
  await db.execute({
    sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_model', ?)",
    args: [value],
  });
}

/** Create the `sections` table (fixed-width vector column) + index if absent. */
export async function ensureSectionsSchema(
  db: Client,
  dimensions: number,
): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      heading TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding F32_BLOB(${dimensions}),
      updated_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'law',
      source_date TEXT
    )`,
  );
  // Caches built before reference sources existed have neither column. The
  // vectors themselves are still valid, so migrate in place rather than forcing
  // a full re-embed: 'law' is the correct default for every row already there.
  for (const ddl of [
    "ALTER TABLE sections ADD COLUMN kind TEXT NOT NULL DEFAULT 'law'",
    'ALTER TABLE sections ADD COLUMN source_date TEXT',
  ]) {
    try {
      await db.execute(ddl);
    } catch {
      // Column already present — the CREATE above supplied it.
    }
  }
  await db.execute(
    `CREATE INDEX IF NOT EXISTS sections_vec_idx
     ON sections (libsql_vector_idx(embedding))`,
  );
}

/** Drop the vector table (used by `lat reindex` before a full rebuild). */
export async function dropSections(db: Client): Promise<void> {
  await db.execute('DROP TABLE IF EXISTS sections');
}

export async function closeDb(db: Client): Promise<void> {
  db.close();
}
