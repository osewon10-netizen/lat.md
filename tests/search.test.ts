import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rmDirBestEffort } from './util.js';
import { tmpdir } from 'node:os';
import { detectProvider, createEmbedder, type Embedder } from '@lat.md/embed';
import minilm from '@lat.md/embed-minilm-fp16';
import {
  openDb,
  ensureMeta,
  ensureSectionsSchema,
  closeDb,
} from '../src/search/db.js';
import { indexSections } from '../src/search/index.js';
import { searchSections } from '../src/search/search.js';
import { runSearch } from '../src/cli/search.js';
import { startReplayServer, hasReplayData } from './rag-replay-server.js';
import type { Client } from '@libsql/client';
import type { Server } from 'node:http';

// --- Unit tests: provider detection (now lives in @lat.md/embed) ---

// @lat: [[search#Provider Detection]]
describe('detectProvider', () => {
  it('detects OpenAI key', () => {
    expect(detectProvider('sk-abc123').name).toBe('openai');
  });
  it('detects Vercel key', () => {
    expect(detectProvider('vck_abc123').name).toBe('vercel');
  });
  it('rejects Anthropic key with helpful message', () => {
    expect(() => detectProvider('sk-ant-abc123')).toThrow(/Anthropic/);
  });
  it('rejects unknown key', () => {
    expect(() => detectProvider('xyz_abc123')).toThrow(/Unrecognized/);
  });
});

// --- RAG functional tests: local MiniLM engine (deterministic, always run) ---
//
// The local backend produces identical vectors for identical text, so these run
// the real WASM engine directly — no API key, no network, no replay recording.

function copyFixture(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'lat-rag-'));
  const latDir = join(tmp, 'lat.md');
  cpSync(join(import.meta.dirname, 'cases', 'rag', 'lat.md'), latDir, {
    recursive: true,
  });
  return latDir;
}

describe('search (rag, local)', () => {
  let latDir: string;
  let db: Client;
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = await createEmbedder({ model: minilm });
    latDir = copyFixture();
    db = openDb(latDir);
    await ensureMeta(db);
    await ensureSectionsSchema(db, embedder.dimensions);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    if (latDir) rmDirBestEffort(join(latDir, '..'));
  });

  // @lat: [[search#RAG Tests#Indexes all sections]]
  it('indexes all sections', async () => {
    const stats = await indexSections(latDir, db, embedder);
    expect(stats.added).toBe(9);
    expect(stats.updated).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.unchanged).toBe(0);
  });

  // @lat: [[search#RAG Tests#Finds auth section for login query]]
  it('finds auth section for login query', async () => {
    const results = await searchSections(
      db,
      'how do we handle user login and security?',
      embedder,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain('Authentication');
  });

  // @lat: [[search#RAG Tests#Finds performance section for latency query]]
  it('finds performance section for latency query', async () => {
    const results = await searchSections(
      db,
      'what tools do we use to measure response times?',
      embedder,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain('Performance');
  });

  // @lat: [[search#RAG Tests#Deterministic embeddings]]
  it('produces identical vectors for identical text', async () => {
    const [a] = await embedder.embed(['stable input']);
    const [b] = await embedder.embed(['stable input']);
    expect(a).toEqual(b);
  });

  // @lat: [[search#RAG Tests#Incremental index skips unchanged sections]]
  it('incremental index skips unchanged sections', async () => {
    const stats = await indexSections(latDir, db, embedder);
    expect(stats.unchanged).toBe(9);
    expect(stats.added).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.removed).toBe(0);
  });

  // @lat: [[search#RAG Tests#Detects deleted sections when file is removed]]
  it('detects deleted sections when file is removed', async () => {
    rmSync(join(latDir, 'testing.md'));
    const stats = await indexSections(latDir, db, embedder);
    expect(stats.removed).toBe(4); // testing + unit + integration + performance
    expect(stats.unchanged).toBe(5); // architecture sections remain
  });
});

// --- Legacy cache upgrade: rebuild a pre-versioning index ---
//
// A `.cache` built by a version that never recorded `meta.embedding_model` has
// rows but no model. Resolving to a different backend (here local 384-dim vs a
// stale remote 1536-dim table) must drop + rebuild, not query the mismatch.

describe('search (rag, legacy cache upgrade)', () => {
  // @lat: [[search#RAG Tests#Rebuilds a legacy cache with no recorded model]]
  it('rebuilds a legacy cache that has rows but no recorded model', async () => {
    const latDir = copyFixture();

    // Seed a populated 1536-dim table (as an old remote build would leave) with
    // no meta.embedding_model recorded.
    const seed = openDb(latDir);
    await ensureMeta(seed);
    await ensureSectionsSchema(seed, 1536);
    const bogus = JSON.stringify(new Array(1536).fill(0.1));
    await seed.execute({
      sql: `INSERT INTO sections (id, file, heading, content, content_hash, embedding, updated_at)
            VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
      args: ['stale#Old', 'stale.md', 'Old', 'stale', 'deadbeef', bogus, 0],
    });
    await closeDb(seed);

    // Clear the env so the rebuild resolves to the local 384-dim model — the
    // dimension mismatch that previously threw a raw libsql error at query time.
    const savedKeys = [
      'LAT_LLM_KEY',
      'LAT_LLM_KEY_FILE',
      'LAT_LLM_KEY_HELPER',
      'XDG_CONFIG_HOME',
    ] as const;
    const saved = Object.fromEntries(savedKeys.map((k) => [k, process.env[k]]));
    const cfg = mkdtempSync(join(tmpdir(), 'lat-cfg-'));
    process.env.LAT_LLM_KEY = '';
    process.env.LAT_LLM_KEY_FILE = '';
    process.env.LAT_LLM_KEY_HELPER = '';
    process.env.XDG_CONFIG_HOME = cfg;

    try {
      const result = await runSearch(
        latDir,
        'how do we handle user login and security?',
        5,
      );
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].section.id).toContain('Authentication');
    } finally {
      for (const k of savedKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmDirBestEffort(cfg);
      rmDirBestEffort(join(latDir, '..'));
    }
  });
});

// --- Hosted backend: replay-based test (supplementary, runs if data present) ---
//
// Exercises the remote fetch backend via a local OpenAI-compatible replay server,
// so the hosted code path stays covered without a live key. Re-cook: pnpm cook-test-rag

const capturing = !!process.env._LAT_TEST_CAPTURE_EMBEDDINGS;
const replayDir = join(import.meta.dirname, 'cases', 'rag', 'replay-data');
const canRunHosted = capturing || hasReplayData(replayDir);

describe.skipIf(!canRunHosted)('search (rag, hosted replay)', () => {
  let latDir: string;
  let db: Client;
  let server: Server;
  let embedder: Embedder;
  let flushCapture: () => void;

  beforeAll(async () => {
    const opts = capturing
      ? (() => {
          const realKey = process.env.LAT_LLM_KEY;
          if (!realKey)
            throw new Error('LAT_LLM_KEY must be set in capture mode');
          return {
            capture: true as const,
            provider: detectProvider(realKey),
            key: realKey,
          };
        })()
      : undefined;
    const replay = await startReplayServer(replayDir, opts);
    server = replay.server;
    flushCapture = replay.flush;
    embedder = await createEmbedder({
      key: `REPLAY_LAT_LLM_KEY::${replay.url}`,
    });

    latDir = copyFixture();
    db = openDb(latDir);
    await ensureMeta(db);
    await ensureSectionsSchema(db, embedder.dimensions);
  });

  afterAll(async () => {
    if (capturing) flushCapture();
    if (db) await closeDb(db);
    if (server) server.close();
    if (latDir) rmDirBestEffort(join(latDir, '..'));
  });

  it('indexes and finds the auth section via the hosted backend', async () => {
    const stats = await indexSections(latDir, db, embedder);
    expect(stats.added).toBe(9);
    const results = await searchSections(
      db,
      'how do we handle user login and security?',
      embedder,
    );
    expect(results[0].id).toContain('Authentication');
  });
});

// --- Reference sources: the second index tier ---
//
// A `lat.ref` file is searchable but is not law. These cover the seam: it
// reaches the index, it carries the tier and the date that let a reader judge
// currency, and an unmarked sibling stays out.

// @lat: [[search#Reference Sources]]
describe('search (reference sources, local)', () => {
  let latDir: string;
  let projectRoot: string;
  let db: Client;
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = await createEmbedder({ model: minilm });
    latDir = copyFixture();
    projectRoot = join(latDir, '..');
    mkdirSync(join(projectRoot, 'specs'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'specs', 'market.md'),
      '---\nlat:\n  ref: true\n---\n\n# Market Semantics\n\n' +
        '## Session Boundaries\n\n' +
        "A trading session opens at 09:30 and closes at 16:00 in the venue's" +
        ' local timezone.\n',
    );
    // Unmarked sibling — the archive case that a docs/ glob would have swept in.
    writeFileSync(
      join(projectRoot, 'specs', 'shipped.md'),
      '# PA-983 Depth Gate\n\nRewritten to sample five book levels. Shipped.\n',
    );
    db = openDb(latDir);
    await ensureMeta(db);
    await ensureSectionsSchema(db, embedder.dimensions);
    await indexSections(latDir, db, embedder);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    if (projectRoot) rmDirBestEffort(projectRoot);
  });

  // @lat: [[search#Reference Sources#Indexes a marked file on the ref tier]]
  it('indexes a marked file and tags the rows as ref', async () => {
    const rows = await db.execute(
      "SELECT id FROM sections WHERE kind = 'ref' ORDER BY id",
    );
    const ids = rows.rows.map((r) => r.id as string);
    expect(ids).toContain('specs/market#Market Semantics#Session Boundaries');
    expect(ids.every((id) => id.startsWith('specs/market'))).toBe(true);
  });

  // @lat: [[search#Reference Sources#Leaves an unmarked file out entirely]]
  it('leaves an unmarked file out of the index entirely', async () => {
    const rows = await db.execute(
      "SELECT COUNT(*) AS n FROM sections WHERE file LIKE 'specs/shipped%'",
    );
    expect(rows.rows[0].n).toBe(0);
  });

  // @lat: [[search#Reference Sources#Keeps lat.md/ sections on the law tier]]
  it('keeps lat.md/ sections on the law tier', async () => {
    const rows = await db.execute(
      "SELECT COUNT(*) AS n FROM sections WHERE kind = 'law'",
    );
    expect(rows.rows[0].n).toBe(9);
  });

  // @lat: [[search#Reference Sources#Returns the tier and date on a hit]]
  it('returns the tier and date on a hit', async () => {
    const results = await searchSections(
      db,
      'when does a trading session open and close?',
      embedder,
    );
    const hit = results.find((r) => r.id.startsWith('specs/market'));
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('ref');
    // The fixture is not a git repo, so there is no commit to date it by —
    // the column is nullable precisely so an unversioned tree still indexes.
    expect(hit!.sourceDate).toBeNull();
  });

  // The marker is the only thing holding a file in the index; dropping it must
  // evict, or an unmarked doc would linger with search authority it lost.
  // @lat: [[search#Reference Sources#Evicts a file whose marker is removed]]
  it('evicts a file whose marker is removed', async () => {
    writeFileSync(
      join(projectRoot, 'specs', 'market.md'),
      '# Market Semantics\n\n## Session Boundaries\n\nUnmarked now.\n',
    );
    const stats = await indexSections(latDir, db, embedder);
    expect(stats.removed).toBe(2); // root + Session Boundaries
    const rows = await db.execute(
      "SELECT COUNT(*) AS n FROM sections WHERE kind = 'ref'",
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
