import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "path";
import fs from "fs";
import { isValidCheckpoint } from "@/lib/database";

const TEST_DB_PATH = path.join(__dirname, "fixtures", "test-db.sqlite");

function setupTestDb(): Client {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const client = createClient({ url: `file:${TEST_DB_PATH}` });
  return client;
}

describe("getTrendingProducts (direct SQL)", () => {
  let db: Client;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("returns top products by stock depletion", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;

    await db.batch([
      `CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY, name TEXT, price REAL, image1 TEXT,
        shopify_product_id TEXT, last_seen_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
        old_qty INTEGER, new_qty INTEGER, change_type TEXT,
        detected_at INTEGER DEFAULT (strftime('%s','now'))
      )`,
    ]);

    await db.batch([
      { sql: `INSERT INTO products (sku, name, price, image1, shopify_product_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-A", "Product A", 99.99, "img-a.jpg", "shop-123", now] },
      { sql: `INSERT INTO products (sku, name, price, image1, shopify_product_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-B", "Product B", 49.99, "img-b.jpg", null, now] },
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-A", 50, 30, sevenDaysAgo] },
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-A", 30, 20, sevenDaysAgo + 86400] },
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-B", 100, 90, sevenDaysAgo] },
    ], "write");

    const result = await db.execute(`
      SELECT ph.sku, p.name, p.price, p.image1, p.shopify_product_id,
             SUM(ph.old_qty - ph.new_qty) as units_moved
      FROM price_history ph
      JOIN products p ON ph.sku = p.sku
      WHERE ph.change_type = 'stock_change'
        AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
        AND ph.old_qty > ph.new_qty
      GROUP BY ph.sku
      ORDER BY units_moved DESC
      LIMIT 10
    `);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].sku).toBe("SKU-A");
    expect(Number(result.rows[0].units_moved)).toBe(30);
    expect(result.rows[1].sku).toBe("SKU-B");
    expect(Number(result.rows[1].units_moved)).toBe(10);
  });

  it("returns empty array when no stock changes exist", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT, price REAL, image1 TEXT, shopify_product_id TEXT, last_seen_at INTEGER)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, old_qty INTEGER, new_qty INTEGER, change_type TEXT, detected_at INTEGER)`);

    const result = await db.execute(`
      SELECT ph.sku, SUM(ph.old_qty - ph.new_qty) as units_moved
      FROM price_history ph
      JOIN products p ON ph.sku = p.sku
      WHERE ph.change_type = 'stock_change'
        AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
        AND ph.old_qty > ph.new_qty
      GROUP BY ph.sku ORDER BY units_moved DESC LIMIT 10
    `);

    expect(result.rows).toHaveLength(0);
  });

  it("ignores stock increases (restocks)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.execute(`CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT, price REAL, image1 TEXT, last_seen_at INTEGER)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, old_qty INTEGER, new_qty INTEGER, change_type TEXT, detected_at INTEGER)`);

    await db.execute({ sql: `INSERT INTO products (sku, name, price, image1, last_seen_at) VALUES (?, ?, ?, ?, ?)`, args: ["SKU-C", "Product C", 29.99, "img-c.jpg", now] });
    await db.execute({ sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-C", 0, 50, now - 86400] });

    const result = await db.execute(`
      SELECT ph.sku FROM price_history ph
      JOIN products p ON ph.sku = p.sku
      WHERE ph.change_type = 'stock_change'
        AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
        AND ph.old_qty > ph.new_qty
    `);

    expect(result.rows).toHaveLength(0);
  });
});

describe("isValidCheckpoint (GAP 1 — type guard)", () => {
  it("returns true for a well-formed checkpoint", () => {
    expect(isValidCheckpoint({
      date: "2026-04-19",
      processedGroupKeys: ["g1", "g2"],
      totalDiffs: 10,
      totalUpdates: 8,
      totalArchived: 2,
      totalErrors: 0,
      done: false,
    })).toBe(true);
  });

  it("returns false when processedGroupKeys is missing", () => {
    expect(isValidCheckpoint({
      date: "2026-04-19",
      totalDiffs: 10,
      totalUpdates: 8,
      totalArchived: 2,
      totalErrors: 0,
      done: false,
    })).toBe(false);
  });

  it("returns false when done is not a boolean", () => {
    expect(isValidCheckpoint({
      date: "2026-04-19",
      processedGroupKeys: [],
      totalDiffs: 10,
      totalUpdates: 0,
      totalArchived: 0,
      totalErrors: 0,
      done: "yes",
    })).toBe(false);
  });

  it("returns false for null, primitives, and empty object", () => {
    expect(isValidCheckpoint(null)).toBe(false);
    expect(isValidCheckpoint("string")).toBe(false);
    expect(isValidCheckpoint({})).toBe(false);
  });
});

describe("completeSyncRun WHERE status='running' guard (GAP 3)", () => {
  let db: Client;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("updates a running row and reports 1 row affected", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL DEFAULT 'running', total_products INTEGER, created INTEGER, updated INTEGER, archived INTEGER, errors INTEGER, error_messages TEXT DEFAULT '[]')`);
    await db.execute({ sql: `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`, args: ["run-1", new Date().toISOString()] });

    const result = await db.execute({ sql: `UPDATE sync_runs SET completed_at=?, status=?, total_products=?, created=?, updated=?, archived=?, errors=?, error_messages=? WHERE id=? AND status='running'`, args: [new Date().toISOString(), "completed", 100, 0, 5, 0, 0, "[]", "run-1"] });
    expect(result.rowsAffected).toBe(1);

    const row = await db.execute({ sql: `SELECT status FROM sync_runs WHERE id=?`, args: ["run-1"] });
    expect(row.rows[0].status).toBe("completed");
  });

  it("does not update an already-completed row (guard prevents double-complete)", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL DEFAULT 'running', total_products INTEGER, created INTEGER, updated INTEGER, archived INTEGER, errors INTEGER, error_messages TEXT DEFAULT '[]')`);
    await db.execute({ sql: `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'completed')`, args: ["run-done", new Date().toISOString()] });

    const result = await db.execute({ sql: `UPDATE sync_runs SET completed_at=?, status=?, total_products=?, created=?, updated=?, archived=?, errors=?, error_messages=? WHERE id=? AND status='running'`, args: [new Date().toISOString(), "failed", 0, 0, 0, 0, 0, "[]", "run-done"] });
    expect(result.rowsAffected).toBe(0);

    const row = await db.execute({ sql: `SELECT status FROM sync_runs WHERE id=?`, args: ["run-done"] });
    expect(row.rows[0].status).toBe("completed");
  });
});

describe("rebuildProductTypeCounts — batch write correctness (direct SQL)", () => {
  let db: Client;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("batch DELETE+INSERT produces the same result as N sequential inserts", async () => {
    await db.batch([
      `CREATE TABLE IF NOT EXISTS product_type_counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)`,
    ]);

    // Simulate typeCounts map: {Furniture: 3, "Furniture > Chairs": 2}
    const typeCounts = new Map([["Furniture", 3], ["Furniture > Chairs", 2]]);
    const inserts = [...typeCounts].map(([type, count]) => ({
      sql: `INSERT INTO product_type_counts (type, count) VALUES (?, ?)`,
      args: [type, count] as [string, number],
    }));
    await db.batch([{ sql: `DELETE FROM product_type_counts`, args: [] }, ...inserts], "write");

    const result = await db.execute(`SELECT type, count FROM product_type_counts ORDER BY type`);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].type).toBe("Furniture");
    expect(Number(result.rows[0].count)).toBe(3);
    expect(result.rows[1].type).toBe("Furniture > Chairs");
    expect(Number(result.rows[1].count)).toBe(2);
  });

  it("batch DELETE clears stale rows before inserting new ones", async () => {
    await db.batch([
      `CREATE TABLE IF NOT EXISTS product_type_counts (type TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)`,
      `INSERT INTO product_type_counts (type, count) VALUES ('Stale Category', 99)`,
    ]);

    const inserts = [{ sql: `INSERT INTO product_type_counts (type, count) VALUES (?, ?)`, args: ["Fresh Category", 5] as [string, number] }];
    await db.batch([{ sql: `DELETE FROM product_type_counts`, args: [] }, ...inserts], "write");

    const result = await db.execute(`SELECT type FROM product_type_counts`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].type).toBe("Fresh Category");
  });
});

describe("getProductsSnapshot — SQL shape (direct SQL)", () => {
  let db: Client;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("returns all 23 snapshot fields including shopify_product_id", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, name TEXT DEFAULT '', price REAL, qty INTEGER,
      color TEXT DEFAULT '', size TEXT DEFAULT '', product_type TEXT DEFAULT '',
      image1 TEXT DEFAULT '', image2 TEXT DEFAULT '', image3 TEXT DEFAULT '',
      image4 TEXT DEFAULT '', image5 TEXT DEFAULT '', image6 TEXT DEFAULT '',
      image7 TEXT DEFAULT '', video TEXT DEFAULT '', description TEXT DEFAULT '',
      short_description TEXT DEFAULT '', material TEXT DEFAULT '', gtin TEXT DEFAULT '',
      weight REAL DEFAULT 0, out_of_stock_expected TEXT DEFAULT '',
      estimated_arrival TEXT DEFAULT '', shopify_product_id TEXT
    )`);
    await db.execute({
      sql: `INSERT INTO products (sku, price, qty, image1, shopify_product_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["SKU-SNAP-1", 99.99, 5, "img.jpg", "shop-999"],
    });

    const result = await db.execute(
      `SELECT sku, name, price, qty, color, size, product_type, image1, image2, image3, image4, image5, image6, image7, video, description, short_description, material, gtin, weight, out_of_stock_expected, estimated_arrival, shopify_product_id FROM products`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.columns).toHaveLength(23);
    expect(result.rows[0].sku).toBe("SKU-SNAP-1");
    expect(Number(result.rows[0].price)).toBe(99.99);
    expect(Number(result.rows[0].qty)).toBe(5);
    expect(result.rows[0].shopify_product_id).toBe("shop-999");
  });

  it("returns null shopify_product_id for unimported products", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, name TEXT DEFAULT '', price REAL DEFAULT 0, qty INTEGER DEFAULT 0,
      color TEXT DEFAULT '', size TEXT DEFAULT '', product_type TEXT DEFAULT '',
      image1 TEXT DEFAULT '', image2 TEXT DEFAULT '', image3 TEXT DEFAULT '',
      image4 TEXT DEFAULT '', image5 TEXT DEFAULT '', image6 TEXT DEFAULT '',
      image7 TEXT DEFAULT '', video TEXT DEFAULT '', description TEXT DEFAULT '',
      short_description TEXT DEFAULT '', material TEXT DEFAULT '', gtin TEXT DEFAULT '',
      weight REAL DEFAULT 0, out_of_stock_expected TEXT DEFAULT '',
      estimated_arrival TEXT DEFAULT '', shopify_product_id TEXT
    )`);
    await db.execute({
      sql: `INSERT INTO products (sku, price, qty) VALUES (?, ?, ?)`,
      args: ["SKU-UNIMPORTED", 49.99, 3],
    });

    const result = await db.execute(
      `SELECT sku, name, price, qty, color, size, product_type, image1, image2, image3, image4, image5, image6, image7, video, description, short_description, material, gtin, weight, out_of_stock_expected, estimated_arrival, shopify_product_id FROM products`
    );

    expect(result.rows[0].shopify_product_id).toBeNull();
    expect(result.rows[0].sku).toBe("SKU-UNIMPORTED");
  });
});

describe("clearStaleLockIfNeeded (direct SQL)", () => {
  let db: Client;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("clears a stale running sync older than 30 minutes", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL DEFAULT 'running', error_messages TEXT DEFAULT '[]')`);

    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    await db.execute({ sql: `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`, args: ["stale-run", staleTime] });

    await db.execute(`
      UPDATE sync_runs SET status = 'failed', completed_at = datetime('now'),
        error_messages = '["Stale lock cleared (timeout > 30 min)"]'
      WHERE status = 'running' AND datetime(started_at) < datetime('now', '-30 minutes')
    `);

    const result = await db.execute({ sql: `SELECT status FROM sync_runs WHERE id = ?`, args: ["stale-run"] });
    expect(result.rows[0].status).toBe("failed");
  });

  it("does not clear a recent running sync", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL DEFAULT 'running', error_messages TEXT DEFAULT '[]')`);

    const recentTime = new Date().toISOString();
    await db.execute({ sql: `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`, args: ["recent-run", recentTime] });

    await db.execute(`
      UPDATE sync_runs SET status = 'failed', completed_at = datetime('now'),
        error_messages = '["Stale lock cleared (timeout > 30 min)"]'
      WHERE status = 'running' AND datetime(started_at) < datetime('now', '-30 minutes')
    `);

    const result = await db.execute({ sql: `SELECT status FROM sync_runs WHERE id = ?`, args: ["recent-run"] });
    expect(result.rows[0].status).toBe("running");
  });
});

describe("csv_blob_cache — SQL logic (direct SQL)", () => {
  let db: Client;

  const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS csv_blob_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    blob_url TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    csv_size_bytes INTEGER NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    upload_duration_ms INTEGER NOT NULL DEFAULT 0,
    download_duration_ms INTEGER NOT NULL DEFAULT 0
  )`;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("returns no rows when table is empty", async () => {
    await db.execute(CREATE_TABLE);
    const { rows } = await db.execute(`SELECT * FROM csv_blob_cache WHERE id = 1`);
    expect(rows).toHaveLength(0);
  });

  it("upserts row and updates on conflict", async () => {
    await db.execute(CREATE_TABLE);
    const upsert = (url: string) => db.execute({
      sql: `INSERT INTO csv_blob_cache (id, blob_url, blob_key, csv_size_bytes, upload_duration_ms, download_duration_ms)
            VALUES (1, ?, 'csv/key', 1000, 100, 200)
            ON CONFLICT(id) DO UPDATE SET blob_url = excluded.blob_url, fetched_at = datetime('now')`,
      args: [url],
    });

    await upsert("https://blob.example.com/v1.csv");
    await upsert("https://blob.example.com/v2.csv");

    const { rows } = await db.execute(`SELECT * FROM csv_blob_cache WHERE id = 1`);
    expect(rows).toHaveLength(1);
    expect(rows[0].blob_url).toBe("https://blob.example.com/v2.csv");
  });
});

describe("isCacheStale (pure function)", () => {
  it("returns false for a timestamp less than 12 hours ago", async () => {
    const { isCacheStale } = await import("@/lib/database");
    const recentUtc = new Date(Date.now() - 6 * 3600 * 1000).toISOString().replace("Z", "");
    expect(isCacheStale(recentUtc)).toBe(false);
  });

  it("returns true for a timestamp older than 12 hours", async () => {
    const { isCacheStale } = await import("@/lib/database");
    const oldUtc = new Date(Date.now() - 13 * 3600 * 1000).toISOString().replace("Z", "");
    expect(isCacheStale(oldUtc)).toBe(true);
  });
});

// Two-step SQL logic used by getEligibleHighlightProduct after the ORDER BY RANDOM()
// bottleneck fix (2026-05-08). Tests validate the replacement queries, not the full
// function (which connects to Turso via ensureSchema).
describe("getEligibleHighlightProduct SQL logic (two-step pattern)", () => {
  let db: ReturnType<typeof setupTestDb>;
  const now = Math.floor(Date.now() / 1000);

  const CREATE_PRODUCTS = `CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER,
    shopify_product_id TEXT, last_posted_at INTEGER
  )`;

  beforeEach(async () => {
    db = setupTestDb();
    await db.execute(CREATE_PRODUCTS);
  });
  afterEach(async () => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it("returns empty when no products have a shopify_product_id", async () => {
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-1", "P1", 10, 5, null, null] });
    const cutoff = now - 30 * 86400;
    const { rows } = await db.execute({ sql: `SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND qty > 0 AND (last_posted_at IS NULL OR last_posted_at < ?)`, args: [cutoff] });
    expect(rows).toHaveLength(0);
  });

  it("returns empty when all eligible products were posted within minDays", async () => {
    const recentPost = now - 5 * 86400; // 5 days ago, within 30-day window
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-1", "P1", 10, 5, "shop-1", recentPost] });
    const cutoff = now - 30 * 86400;
    const { rows } = await db.execute({ sql: `SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND qty > 0 AND (last_posted_at IS NULL OR last_posted_at < ?)`, args: [cutoff] });
    expect(rows).toHaveLength(0);
  });

  it("returns eligible SKUs with null last_posted_at", async () => {
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-1", "P1", 10, 5, "shop-1", null] });
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-2", "P2", 20, 0, "shop-2", null] }); // qty=0, excluded
    const cutoff = now - 30 * 86400;
    const { rows } = await db.execute({ sql: `SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND qty > 0 AND (last_posted_at IS NULL OR last_posted_at < ?)`, args: [cutoff] });
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).sku).toBe("SKU-1");
  });

  it("returns eligible SKUs posted more than minDays ago", async () => {
    const oldPost = now - 35 * 86400; // 35 days ago, outside 30-day window → eligible
    const recentPost = now - 5 * 86400; // 5 days ago → excluded
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-A", "PA", 10, 5, "shop-A", oldPost] });
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-B", "PB", 20, 3, "shop-B", recentPost] });
    const cutoff = now - 30 * 86400;
    const { rows } = await db.execute({ sql: `SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND qty > 0 AND (last_posted_at IS NULL OR last_posted_at < ?)`, args: [cutoff] });
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).sku).toBe("SKU-A");
  });

  it("second-step fetch by SKU returns full product row", async () => {
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-X", "Product X", 99.99, 10, "shop-X", null] });
    const { rows } = await db.execute({ sql: `SELECT * FROM products WHERE sku = ?`, args: ["SKU-X"] });
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).name).toBe("Product X");
    expect((rows[0] as Record<string, unknown>).price).toBe(99.99);
  });

  it("selects from multi-SKU pool — JS random pick is one of the eligible SKUs", async () => {
    const cutoff = now - 30 * 86400;
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-1", "P1", 10, 5, "shop-1", null] });
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-2", "P2", 20, 3, "shop-2", null] });
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-3", "P3", 30, 1, "shop-3", null] });
    const { rows } = await db.execute({ sql: `SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND qty > 0 AND (last_posted_at IS NULL OR last_posted_at < ?)`, args: [cutoff] });
    expect(rows).toHaveLength(3);
    const skus = rows.map((r) => (r as unknown as Record<string, unknown>).sku as string);
    const randomSku = skus[Math.floor(Math.random() * skus.length)];
    expect(["SKU-1", "SKU-2", "SKU-3"]).toContain(randomSku);
  });

  it("second-step fetch returns empty when SKU was removed between steps (TOCTOU)", async () => {
    await db.execute({ sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)`, args: ["SKU-GONE", "Gone", 10, 5, "shop-gone", null] });
    // Simulate TOCTOU: SKU appears in step-1 results but is deleted before step-2
    await db.execute({ sql: `DELETE FROM products WHERE sku = ?`, args: ["SKU-GONE"] });
    const { rows } = await db.execute({ sql: `SELECT * FROM products WHERE sku = ?`, args: ["SKU-GONE"] });
    expect(rows).toHaveLength(0); // function returns null in this case
  });
});

// ─── getProducts — sort by best_sellers + price_drop (direct SQL) ────────────

describe("getProducts sort — best_sellers and price_drop (direct SQL)", () => {
  let db: ReturnType<typeof setupTestDb>;
  const now = Math.floor(Date.now() / 1000);
  const cutoff14d = now - 14 * 86400;
  const withinWindow = now - 7 * 86400;
  const outsideWindow = now - 20 * 86400;

  beforeEach(async () => {
    db = setupTestDb();
    await db.batch([
      `CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER,
        color TEXT, product_type TEXT, image1 TEXT, shopify_product_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
        old_price REAL, new_price REAL, old_qty INTEGER, new_qty INTEGER,
        change_type TEXT, detected_at INTEGER
      )`,
    ]);
  });

  afterEach(async () => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it("best_sellers: orders by units_moved DESC over 14d window", async () => {
    await db.batch([
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-A", "Alpha", 100, 5, "", "", "", null] },
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-B", "Beta",  200, 3, "", "", "", null] },
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-C", "Gamma", 300, 1, "", "", "", null] },
      // SKU-A: 30 units sold (within window)
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-A", 50, 20, withinWindow] },
      // SKU-B: 10 units sold (within window)
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-B", 40, 30, withinWindow] },
      // SKU-C: 5 units sold but OUTSIDE 14d window — should not count
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-C", 20, 15, outsideWindow] },
    ]);

    const { rows } = await db.execute({
      sql: `WITH filtered AS (SELECT sku, name, price, qty, color, product_type, image1, shopify_product_id FROM products),
            ph_agg AS (SELECT sku, SUM(old_qty - new_qty) AS units_moved FROM price_history WHERE detected_at > ? AND change_type = 'stock_change' AND old_qty > new_qty GROUP BY sku)
            SELECT f.sku, COALESCE(ph_agg.units_moved, 0) AS units_moved
            FROM filtered f LEFT JOIN ph_agg ON ph_agg.sku = f.sku
            ORDER BY COALESCE(ph_agg.units_moved, 0) DESC`,
      args: [cutoff14d],
    });

    const skus = rows.map((r) => (r as unknown as Record<string, unknown>).sku as string);
    expect(skus[0]).toBe("SKU-A"); // 30 units
    expect(skus[1]).toBe("SKU-B"); // 10 units
    expect(skus[2]).toBe("SKU-C"); // 0 units (history outside window)
  });

  it("best_sellers: products with no price_history go last (COALESCE null → 0)", async () => {
    await db.batch([
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-X", "WithHistory", 100, 5, "", "", "", null] },
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-Y", "NoHistory",  200, 3, "", "", "", null] },
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-X", 20, 5, withinWindow] },
    ]);

    const { rows } = await db.execute({
      sql: `WITH filtered AS (SELECT sku, name, price, qty, color, product_type, image1, shopify_product_id FROM products),
            ph_agg AS (SELECT sku, SUM(old_qty - new_qty) AS units_moved FROM price_history WHERE detected_at > ? AND change_type = 'stock_change' AND old_qty > new_qty GROUP BY sku)
            SELECT f.sku FROM filtered f LEFT JOIN ph_agg ON ph_agg.sku = f.sku
            ORDER BY COALESCE(ph_agg.units_moved, 0) DESC`,
      args: [cutoff14d],
    });

    const skus = rows.map((r) => (r as unknown as Record<string, unknown>).sku as string);
    expect(skus[0]).toBe("SKU-X"); // 15 units moved
    expect(skus[1]).toBe("SKU-Y"); // no history → COALESCE 0
  });

  it("best_sellers: restock entries (old_qty < new_qty) are excluded and don't rank products down", async () => {
    await db.batch([
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-SELL", "HighSell", 100, 5, "", "", "", null] },
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-RESTOCK", "HeavyRestock", 200, 3, "", "", "", null] },
      // SKU-SELL: sold 20 units
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-SELL", 50, 30, withinWindow] },
      // SKU-RESTOCK: received 100 units (restock, old_qty < new_qty) — must NOT inflate or deflate rank
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`, args: ["SKU-RESTOCK", 10, 110, withinWindow] },
    ]);

    const { rows } = await db.execute({
      sql: `WITH filtered AS (SELECT sku, name, price, qty, color, product_type, image1, shopify_product_id FROM products),
            ph_agg AS (SELECT sku, SUM(old_qty - new_qty) AS units_moved FROM price_history WHERE detected_at > ? AND change_type = 'stock_change' AND old_qty > new_qty GROUP BY sku)
            SELECT f.sku, COALESCE(ph_agg.units_moved, 0) AS units_moved
            FROM filtered f LEFT JOIN ph_agg ON ph_agg.sku = f.sku
            ORDER BY COALESCE(ph_agg.units_moved, 0) DESC`,
      args: [cutoff14d],
    });

    const skus = rows.map((r) => (r as unknown as Record<string, unknown>).sku as string);
    const units = rows.map((r) => Number((r as unknown as Record<string, unknown>).units_moved));
    expect(skus[0]).toBe("SKU-SELL");    // 20 units sold
    expect(skus[1]).toBe("SKU-RESTOCK"); // restock excluded → COALESCE 0, not -100
    expect(units[1]).toBe(0);            // guard confirmed: not negative
  });

  it("price_drop: orders by drop % DESC, products with no price drop go last", async () => {
    await db.batch([
      // SKU-A: $100 now, was $200 → 50% drop
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-A", "BigDrop",   100, 5, "", "", "", null] },
      // SKU-B: $90 now, was $100 → 10% drop
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-B", "SmallDrop",  90, 3, "", "", "", null] },
      // SKU-C: no price history
      { sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: ["SKU-C", "NoDrop",    200, 1, "", "", "", null] },
      { sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, ?, ?, 'price_change', ?)`, args: ["SKU-A", 200, 100, 5, 5, withinWindow] },
      { sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, ?, ?, 'price_change', ?)`, args: ["SKU-B", 100,  90, 3, 3, withinWindow] },
    ]);

    const { rows } = await db.execute({
      sql: `WITH filtered AS (SELECT sku, name, price, qty, color, product_type, image1, shopify_product_id FROM products),
            ph_agg AS (
              SELECT ph.sku,
                ROUND(((MAX(ph.old_price) - MIN(p2.price)) / MAX(ph.old_price)) * 100.0, 1) AS drop_pct
              FROM price_history ph JOIN products p2 ON p2.sku = ph.sku
              WHERE ph.detected_at > ? AND ph.old_price > p2.price
              GROUP BY ph.sku
            )
            SELECT f.sku, COALESCE(ph_agg.drop_pct, 0) AS drop_pct
            FROM filtered f LEFT JOIN ph_agg ON ph_agg.sku = f.sku
            ORDER BY COALESCE(ph_agg.drop_pct, 0) DESC`,
      args: [cutoff14d],
    });

    const skus = rows.map((r) => (r as unknown as Record<string, unknown>).sku as string);
    expect(skus[0]).toBe("SKU-A"); // 50% drop
    expect(skus[1]).toBe("SKU-B"); // 10% drop
    expect(skus[2]).toBe("SKU-C"); // no history → 0%
    const dropA = Number((rows[0] as unknown as Record<string, unknown>).drop_pct);
    expect(dropA).toBe(50.0);
  });
});
