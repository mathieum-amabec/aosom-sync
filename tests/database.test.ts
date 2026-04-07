import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Use a temp DB for test isolation
const TEST_DB_PATH = path.join(__dirname, "fixtures", "test-db.sqlite");

function setupTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER,
      color TEXT, size TEXT, product_type TEXT,
      image1 TEXT, image2 TEXT, image3 TEXT, image4 TEXT, image5 TEXT, image6 TEXT, image7 TEXT,
      video TEXT, description TEXT, short_description TEXT, material TEXT, gtin TEXT, weight REAL,
      out_of_stock_expected TEXT, estimated_arrival TEXT,
      shopify_product_id TEXT, shopify_variant_id TEXT,
      last_seen_at INTEGER, last_posted_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
      old_price REAL, new_price REAL, old_qty INTEGER, new_qty INTEGER,
      change_type TEXT, detected_at INTEGER DEFAULT (strftime('%s','now')),
      applied_to_shopify INTEGER DEFAULT 0,
      FOREIGN KEY (sku) REFERENCES products(sku)
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_products INTEGER DEFAULT 0, created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0, error_messages TEXT DEFAULT '[]'
    );
  `);
  return db;
}

describe("getTrendingProducts (direct SQL)", () => {
  let db: Database.Database;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("returns top products by stock depletion", () => {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 86400;

    // Seed products
    db.prepare(`INSERT INTO products (sku, name, price, image1, shopify_product_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("SKU-A", "Product A", 99.99, "img-a.jpg", "shop-123", now);
    db.prepare(`INSERT INTO products (sku, name, price, image1, shopify_product_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("SKU-B", "Product B", 49.99, "img-b.jpg", null, now);

    // Seed price_history: SKU-A sold 30 units, SKU-B sold 10
    db.prepare(`INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`)
      .run("SKU-A", 50, 30, sevenDaysAgo);
    db.prepare(`INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`)
      .run("SKU-A", 30, 20, sevenDaysAgo + 86400);
    db.prepare(`INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`)
      .run("SKU-B", 100, 90, sevenDaysAgo);

    // Run the same query as getTrendingProducts
    const results = db.prepare(`
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
    `).all() as { sku: string; units_moved: number }[];

    expect(results).toHaveLength(2);
    expect(results[0].sku).toBe("SKU-A");
    expect(results[0].units_moved).toBe(30); // 20 + 10
    expect(results[1].sku).toBe("SKU-B");
    expect(results[1].units_moved).toBe(10);
  });

  it("returns empty array when no stock changes exist", () => {
    const results = db.prepare(`
      SELECT ph.sku, SUM(ph.old_qty - ph.new_qty) as units_moved
      FROM price_history ph
      JOIN products p ON ph.sku = p.sku
      WHERE ph.change_type = 'stock_change'
        AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
        AND ph.old_qty > ph.new_qty
      GROUP BY ph.sku ORDER BY units_moved DESC LIMIT 10
    `).all();

    expect(results).toHaveLength(0);
  });

  it("ignores stock increases (restocks)", () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO products (sku, name, price, image1, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
      .run("SKU-C", "Product C", 29.99, "img-c.jpg", now);
    // This is a restock (old_qty < new_qty), should be excluded
    db.prepare(`INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES (?, ?, ?, 'stock_change', ?)`)
      .run("SKU-C", 0, 50, now - 86400);

    const results = db.prepare(`
      SELECT ph.sku FROM price_history ph
      JOIN products p ON ph.sku = p.sku
      WHERE ph.change_type = 'stock_change'
        AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
        AND ph.old_qty > ph.new_qty
    `).all();

    expect(results).toHaveLength(0);
  });
});

describe("clearStaleLockIfNeeded (direct SQL)", () => {
  let db: Database.Database;

  beforeEach(() => { db = setupTestDb(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("clears a stale running sync older than 30 minutes", () => {
    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`)
      .run("stale-run", staleTime);

    // Run the same query as clearStaleLockIfNeeded
    db.prepare(`
      UPDATE sync_runs SET status = 'failed', completed_at = datetime('now'),
        error_messages = '["Stale lock cleared (timeout > 30 min)"]'
      WHERE status = 'running' AND datetime(started_at) < datetime('now', '-30 minutes')
    `).run();

    const row = db.prepare(`SELECT status FROM sync_runs WHERE id = ?`).get("stale-run") as { status: string };
    expect(row.status).toBe("failed");
  });

  it("does not clear a recent running sync", () => {
    const recentTime = new Date().toISOString();
    db.prepare(`INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`)
      .run("recent-run", recentTime);

    db.prepare(`
      UPDATE sync_runs SET status = 'failed', completed_at = datetime('now'),
        error_messages = '["Stale lock cleared (timeout > 30 min)"]'
      WHERE status = 'running' AND datetime(started_at) < datetime('now', '-30 minutes')
    `).run();

    const row = db.prepare(`SELECT status FROM sync_runs WHERE id = ?`).get("recent-run") as { status: string };
    expect(row.status).toBe("running");
  });
});
