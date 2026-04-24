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

  it("returns all 13 snapshot fields including shopify_product_id", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, price REAL, qty INTEGER,
      image1 TEXT DEFAULT '', image2 TEXT DEFAULT '', image3 TEXT DEFAULT '',
      image4 TEXT DEFAULT '', image5 TEXT DEFAULT '', image6 TEXT DEFAULT '',
      image7 TEXT DEFAULT '', out_of_stock_expected TEXT DEFAULT '',
      estimated_arrival TEXT DEFAULT '', shopify_product_id TEXT
    )`);
    await db.execute({
      sql: `INSERT INTO products (sku, price, qty, image1, shopify_product_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["SKU-SNAP-1", 99.99, 5, "img.jpg", "shop-999"],
    });

    const result = await db.execute(
      `SELECT sku, price, qty, image1, image2, image3, image4, image5, image6, image7, out_of_stock_expected, estimated_arrival, shopify_product_id FROM products`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.columns).toHaveLength(13);
    expect(result.rows[0].sku).toBe("SKU-SNAP-1");
    expect(Number(result.rows[0].price)).toBe(99.99);
    expect(Number(result.rows[0].qty)).toBe(5);
    expect(result.rows[0].shopify_product_id).toBe("shop-999");
  });

  it("returns null shopify_product_id for unimported products", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, price REAL DEFAULT 0, qty INTEGER DEFAULT 0,
      image1 TEXT DEFAULT '', image2 TEXT DEFAULT '', image3 TEXT DEFAULT '',
      image4 TEXT DEFAULT '', image5 TEXT DEFAULT '', image6 TEXT DEFAULT '',
      image7 TEXT DEFAULT '', out_of_stock_expected TEXT DEFAULT '',
      estimated_arrival TEXT DEFAULT '', shopify_product_id TEXT
    )`);
    await db.execute({
      sql: `INSERT INTO products (sku, price, qty) VALUES (?, ?, ?)`,
      args: ["SKU-UNIMPORTED", 49.99, 3],
    });

    const result = await db.execute(
      `SELECT sku, price, qty, image1, image2, image3, image4, image5, image6, image7, out_of_stock_expected, estimated_arrival, shopify_product_id FROM products`
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
