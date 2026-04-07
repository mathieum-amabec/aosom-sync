import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "path";
import fs from "fs";

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
