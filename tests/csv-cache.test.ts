import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "path";
import fs from "fs";

// Tests operate on a local SQLite file — no Turso, no Next.js module loading.
// Each test group gets a fresh DB to avoid state bleed.

const TEST_DB_PATH = path.join(__dirname, "fixtures", "csv-cache-test.sqlite");

const CREATE_CSV_CACHE = `CREATE TABLE IF NOT EXISTS csv_cache (
  slot TEXT PRIMARY KEY CHECK (slot IN ('current', 'previous')),
  raw_text TEXT NOT NULL,
  bytes_size INTEGER NOT NULL,
  fetched_at TIMESTAMP NOT NULL,
  fetch_duration_ms INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

const CREATE_CSV_CACHE_LOG = `CREATE TABLE IF NOT EXISTS csv_cache_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  bytes_size INTEGER,
  fetch_duration_ms INTEGER,
  success INTEGER NOT NULL,
  error_message TEXT,
  source_url TEXT
)`;

const CREATE_CSV_CACHE_LOG_IDX = `CREATE INDEX IF NOT EXISTS idx_csv_cache_log_fetched_at ON csv_cache_log(fetched_at DESC)`;

function makeDb(): Client {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return createClient({ url: `file:${TEST_DB_PATH}` });
}

async function seedSchema(db: Client): Promise<void> {
  await db.batch(
    [CREATE_CSV_CACHE, CREATE_CSV_CACHE_LOG, CREATE_CSV_CACHE_LOG_IDX].map((sql) => ({ sql, args: [] })),
    "write"
  );
}

const NOW = "2026-04-26T10:00:00.000Z";
const SOURCE = "https://feed-us.aosomcdn.com/test.csv";

async function upsertCurrent(db: Client, raw: string, success = true, errorMsg: string | null = null) {
  const now = NOW;
  await db.batch(
    [
      {
        sql: `INSERT INTO csv_cache
                (slot, raw_text, bytes_size, fetched_at, fetch_duration_ms,
                 source_url, success, error_message, created_at, updated_at)
              SELECT 'previous', raw_text, bytes_size, fetched_at,
                     fetch_duration_ms, source_url, success, error_message,
                     created_at, ?
              FROM csv_cache
              WHERE slot = 'current'
              ON CONFLICT(slot) DO UPDATE SET
                raw_text = excluded.raw_text,
                bytes_size = excluded.bytes_size,
                fetched_at = excluded.fetched_at,
                fetch_duration_ms = excluded.fetch_duration_ms,
                source_url = excluded.source_url,
                success = excluded.success,
                error_message = excluded.error_message,
                updated_at = ?`,
        args: [now, now],
      },
      {
        sql: `INSERT INTO csv_cache
                (slot, raw_text, bytes_size, fetched_at, fetch_duration_ms,
                 source_url, success, error_message, created_at, updated_at)
              VALUES ('current', ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(slot) DO UPDATE SET
                raw_text = excluded.raw_text,
                bytes_size = excluded.bytes_size,
                fetched_at = excluded.fetched_at,
                fetch_duration_ms = excluded.fetch_duration_ms,
                source_url = excluded.source_url,
                success = excluded.success,
                error_message = excluded.error_message,
                updated_at = ?`,
        args: [raw, raw.length, now, 1000, SOURCE, success ? 1 : 0, errorMsg, now, now, now],
      },
    ],
    "write"
  );
}

describe("csv_cache schema", () => {
  let db: Client;

  beforeEach(() => { db = makeDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("Test 1 — migration is idempotent (3 runs no error)", async () => {
    for (let i = 0; i < 3; i++) {
      await seedSchema(db);
    }
    const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('csv_cache', 'csv_cache_log')`);
    expect(tables.rows).toHaveLength(2);
    const idx = await db.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_csv_cache_log_fetched_at'`);
    expect(idx.rows).toHaveLength(1);
  });

  it("Test 2 — csv_cache PRIMARY KEY rejects invalid slot value", async () => {
    await seedSchema(db);
    await expect(
      db.execute({ sql: `INSERT INTO csv_cache (slot, raw_text, bytes_size, fetched_at, fetch_duration_ms, source_url) VALUES ('other', 'x', 1, ?, 100, ?)`, args: [NOW, SOURCE] })
    ).rejects.toThrow();
  });
});

describe("csv_cache CRUD", () => {
  let db: Client;

  beforeEach(async () => { db = makeDb(); await seedSchema(db); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("Test 3 — getCachedCSV returns null when current empty", async () => {
    const result = await db.execute({ sql: `SELECT raw_text, bytes_size, fetched_at, source_url FROM csv_cache WHERE slot = 'current' AND success = 1 LIMIT 1`, args: [] });
    expect(result.rows).toHaveLength(0);
  });

  it("Test 4 — upsertCachedCSV with no existing current writes only current row", async () => {
    await upsertCurrent(db, "hello");

    const all = await db.execute(`SELECT slot, raw_text FROM csv_cache`);
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0].slot).toBe("current");
    expect(all.rows[0].raw_text).toBe("hello");

    const current = await db.execute({ sql: `SELECT raw_text FROM csv_cache WHERE slot = 'current' AND success = 1 LIMIT 1`, args: [] });
    expect(current.rows[0].raw_text).toBe("hello");

    const previous = await db.execute({ sql: `SELECT raw_text FROM csv_cache WHERE slot = 'previous' AND success = 1 LIMIT 1`, args: [] });
    expect(previous.rows).toHaveLength(0);
  });

  it("Test 5 — upsertCachedCSV rotates current → previous on second call", async () => {
    await upsertCurrent(db, "V1");
    await upsertCurrent(db, "V2");

    const all = await db.execute(`SELECT slot, raw_text FROM csv_cache ORDER BY slot`);
    expect(all.rows).toHaveLength(2);

    const current = await db.execute({ sql: `SELECT raw_text FROM csv_cache WHERE slot = 'current' AND success = 1 LIMIT 1`, args: [] });
    expect(current.rows[0].raw_text).toBe("V2");

    const previous = await db.execute({ sql: `SELECT raw_text FROM csv_cache WHERE slot = 'previous' AND success = 1 LIMIT 1`, args: [] });
    expect(previous.rows[0].raw_text).toBe("V1");
  });

  it("Test 6 — upsertCachedCSV with success=false makes getCachedCSV return null", async () => {
    await upsertCurrent(db, "V1");
    // Second insert is a failure
    await upsertCurrent(db, "", false, "timeout");

    // current has success=0 → filtered out
    const current = await db.execute({ sql: `SELECT raw_text FROM csv_cache WHERE slot = 'current' AND success = 1 LIMIT 1`, args: [] });
    expect(current.rows).toHaveLength(0);

    // previous (V1, success=1) still accessible
    const previous = await db.execute({ sql: `SELECT raw_text FROM csv_cache WHERE slot = 'previous' AND success = 1 LIMIT 1`, args: [] });
    expect(previous.rows[0].raw_text).toBe("V1");
  });
});

describe("csv_cache_log", () => {
  let db: Client;

  beforeEach(async () => { db = makeDb(); await seedSchema(db); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("Test 7 — appendCacheLog writes row without affecting csv_cache", async () => {
    await db.execute({
      sql: `INSERT INTO csv_cache_log (bytes_size, fetch_duration_ms, success, error_message, source_url) VALUES (?, ?, ?, ?, ?)`,
      args: [45000000, 8000, 1, null, SOURCE],
    });

    const logs = await db.execute(`SELECT * FROM csv_cache_log`);
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0].success).toBe(1);

    const cache = await db.execute(`SELECT * FROM csv_cache`);
    expect(cache.rows).toHaveLength(0);
  });

  it("Test 8 — csv_cache_log rows are queryable in chronological order (DESC)", async () => {
    const times = ["2026-04-26T08:00:00.000Z", "2026-04-26T09:00:00.000Z", "2026-04-26T10:00:00.000Z"];
    for (const ts of times) {
      await db.execute({
        sql: `INSERT INTO csv_cache_log (fetched_at, bytes_size, fetch_duration_ms, success, source_url) VALUES (?, ?, ?, ?, ?)`,
        args: [ts, 45000000, 7500, 1, SOURCE],
      });
    }

    const logs = await db.execute(`SELECT fetched_at FROM csv_cache_log ORDER BY fetched_at DESC`);
    expect(logs.rows).toHaveLength(3);
    expect(logs.rows[0].fetched_at).toBe("2026-04-26T10:00:00.000Z");
    expect(logs.rows[2].fetched_at).toBe("2026-04-26T08:00:00.000Z");
  });
});
