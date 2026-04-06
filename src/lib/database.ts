import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { SyncRun, SyncLogEntry, ChangeType } from "@/types/sync";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "aosom-sync.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(d: Database.Database) {
  // Load schema from schema.sql
  const schemaPath = path.join(process.cwd(), "src", "db", "schema.sql");
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf-8");
    d.exec(schema);
  }

  // Legacy tables still needed for sync runs and import pipeline
  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_products INTEGER DEFAULT 0,
      created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      error_messages TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      sync_run_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      shopify_product_id TEXT,
      sku TEXT NOT NULL,
      action TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY,
      group_key TEXT UNIQUE NOT NULL,
      product_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      content TEXT,
      shopify_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_logs_run ON sync_logs(sync_run_id);
    CREATE INDEX IF NOT EXISTS idx_sync_logs_sku ON sync_logs(sku);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_date ON sync_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);
  `);
}

// ─── Products (replaces catalog_snapshots) ───────────────────────────

export interface ProductRow {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  size: string;
  product_type: string;
  image1: string;
  image2: string;
  image3: string;
  image4: string;
  image5: string;
  image6: string;
  image7: string;
  video: string;
  description: string;
  short_description: string;
  material: string;
  gtin: string;
  weight: number;
  out_of_stock_expected: string;
  estimated_arrival: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  last_seen_at: number;
  last_posted_at: number | null;
  created_at: number;
}

export function refreshProducts(products: Omit<ProductRow, "shopify_product_id" | "shopify_variant_id" | "last_posted_at" | "created_at">[]): void {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = d.prepare(`
    INSERT INTO products (sku, name, price, qty, color, size, product_type,
      image1, image2, image3, image4, image5, image6, image7, video,
      description, short_description, material, gtin, weight,
      out_of_stock_expected, estimated_arrival, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      name=excluded.name, price=excluded.price, qty=excluded.qty,
      color=excluded.color, size=excluded.size, product_type=excluded.product_type,
      image1=excluded.image1, image2=excluded.image2, image3=excluded.image3,
      image4=excluded.image4, image5=excluded.image5, image6=excluded.image6,
      image7=excluded.image7, video=excluded.video,
      description=excluded.description, short_description=excluded.short_description,
      material=excluded.material, gtin=excluded.gtin, weight=excluded.weight,
      out_of_stock_expected=excluded.out_of_stock_expected,
      estimated_arrival=excluded.estimated_arrival, last_seen_at=excluded.last_seen_at
  `);
  const upsertAll = d.transaction((rows: typeof products) => {
    for (const p of rows) {
      stmt.run(
        p.sku, p.name, p.price, p.qty, p.color, p.size, p.product_type,
        p.image1, p.image2, p.image3, p.image4, p.image5, p.image6, p.image7,
        p.video, p.description, p.short_description, p.material, p.gtin, p.weight,
        p.out_of_stock_expected, p.estimated_arrival, now
      );
    }
  });
  upsertAll(products);
}

export function getProduct(sku: string): ProductRow | null {
  const d = getDb();
  return (d.prepare(`SELECT * FROM products WHERE sku = ?`).get(sku) as ProductRow) || null;
}

export function getProducts(filters: {
  productType?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  color?: string;
  size?: string;
  page?: number;
  limit?: number;
  sort?: string;
}): { products: ProductRow[]; total: number; productTypes: { type: string; count: number }[] } {
  const d = getDb();
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filters.productType) { conditions.push(`product_type LIKE ?`); args.push(`${filters.productType}%`); }
  if (filters.search) { conditions.push(`(name LIKE ? OR sku LIKE ?)`); args.push(`%${filters.search}%`, `%${filters.search}%`); }
  if (filters.minPrice !== undefined) { conditions.push(`price >= ?`); args.push(filters.minPrice); }
  if (filters.maxPrice !== undefined) { conditions.push(`price <= ?`); args.push(filters.maxPrice); }
  if (filters.inStock) { conditions.push(`qty > 0`); }
  if (filters.color) { conditions.push(`color = ?`); args.push(filters.color); }
  if (filters.size) { conditions.push(`size = ?`); args.push(filters.size); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(Math.max(1, filters.limit || 50), 200);
  const offset = (page - 1) * limit;

  // Sort
  let orderBy = "name ASC";
  switch (filters.sort) {
    case "price_asc": orderBy = "price ASC"; break;
    case "price_desc": orderBy = "price DESC"; break;
    case "qty_asc": orderBy = "qty ASC"; break;
    case "qty_desc": orderBy = "qty DESC"; break;
    case "name_asc": orderBy = "name ASC"; break;
    case "name_desc": orderBy = "name DESC"; break;
  }

  const total = (d.prepare(`SELECT COUNT(*) as cnt FROM products ${where}`).get(...args) as { cnt: number }).cnt;

  const products = d.prepare(
    `SELECT * FROM products ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as ProductRow[];

  const typeRows = d.prepare(
    `SELECT product_type, COUNT(*) as cnt FROM products WHERE product_type != '' GROUP BY product_type ORDER BY product_type`
  ).all() as { product_type: string; cnt: number }[];

  const typeCounts = new Map<string, number>();
  for (const row of typeRows) {
    const parts = row.product_type.split(">").map((s: string) => s.trim());
    let p = "";
    for (const part of parts) {
      p = p ? `${p} > ${part}` : part;
      typeCounts.set(p, (typeCounts.get(p) || 0) + row.cnt);
    }
  }

  return {
    products,
    total,
    productTypes: Array.from(typeCounts.entries()).map(([type, count]) => ({ type, count })).sort((a, b) => a.type.localeCompare(b.type)),
  };
}

export function getProductCount(): number {
  const d = getDb();
  return (d.prepare(`SELECT COUNT(*) as cnt FROM products`).get() as { cnt: number }).cnt;
}

export function getImportedProductCount(): number {
  const d = getDb();
  return (d.prepare(`SELECT COUNT(*) as cnt FROM products WHERE shopify_product_id IS NOT NULL`).get() as { cnt: number }).cnt;
}

export function updateProductShopifyIds(sku: string, shopifyProductId: string, shopifyVariantId: string): void {
  const d = getDb();
  d.prepare(`UPDATE products SET shopify_product_id = ?, shopify_variant_id = ? WHERE sku = ?`)
    .run(shopifyProductId, shopifyVariantId, sku);
}

// ─── Price History (enriched) ────────────────────────────────────────

export type ChangeTypeHistory = "price_drop" | "price_increase" | "stock_change" | "new_product" | "restock";

export function recordPriceChange(entry: {
  sku: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldQty: number | null;
  newQty: number | null;
  changeType: ChangeTypeHistory;
}): void {
  const d = getDb();
  d.prepare(`INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(entry.sku, entry.oldPrice, entry.newPrice, entry.oldQty, entry.newQty, entry.changeType);
}

export function recordPriceChanges(entries: {
  sku: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldQty: number | null;
  newQty: number | null;
  changeType: ChangeTypeHistory;
}[]): void {
  const d = getDb();
  const stmt = d.prepare(`INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertMany = d.transaction((rows: typeof entries) => {
    for (const e of rows) {
      stmt.run(e.sku, e.oldPrice, e.newPrice, e.oldQty, e.newQty, e.changeType);
    }
  });
  insertMany(entries);
}

export function markPriceChangeApplied(id: number): void {
  const d = getDb();
  d.prepare(`UPDATE price_history SET applied_to_shopify = 1 WHERE id = ?`).run(id);
}

export function getRecentPriceChanges(limit = 50): Record<string, unknown>[] {
  const d = getDb();
  return d.prepare(`
    SELECT ph.*, p.name, p.image1
    FROM price_history ph
    LEFT JOIN products p ON ph.sku = p.sku
    ORDER BY ph.detected_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];
}

// ─── Settings ────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const d = getDb();
  const row = d.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  d.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, value, now);
}

export function getAllSettings(): Record<string, string> {
  const d = getDb();
  const rows = d.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ─── Sync Runs ───────────────────────────────────────────────────────

export function createSyncRun(): SyncRun {
  const d = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`).run(id, now);
  return { id, startedAt: now, completedAt: null, status: "running", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 0, errorMessages: [] };
}

export function completeSyncRun(
  id: string,
  stats: { status: "completed" | "failed"; totalProducts: number; created: number; updated: number; archived: number; errors: number; errorMessages: string[] }
): void {
  const d = getDb();
  d.prepare(`UPDATE sync_runs SET completed_at=?, status=?, total_products=?, created=?, updated=?, archived=?, errors=?, error_messages=? WHERE id=?`)
    .run(new Date().toISOString(), stats.status, stats.totalProducts, stats.created, stats.updated, stats.archived, stats.errors, JSON.stringify(stats.errorMessages), id);
}

export function getSyncRuns(limit = 20): SyncRun[] {
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  return rows.map(mapSyncRun);
}

export function getLatestSyncRun(): SyncRun | null {
  const d = getDb();
  const row = d.prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
  return row ? mapSyncRun(row) : null;
}

function mapSyncRun(row: Record<string, unknown>): SyncRun {
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) || null,
    status: row.status as SyncRun["status"],
    totalProducts: (row.total_products as number) || 0,
    created: (row.created as number) || 0,
    updated: (row.updated as number) || 0,
    archived: (row.archived as number) || 0,
    errors: (row.errors as number) || 0,
    errorMessages: JSON.parse((row.error_messages as string) || "[]"),
  };
}

// ─── Sync Logs ───────────────────────────────────────────────────────

export function addSyncLogsBatch(entries: Omit<SyncLogEntry, "id">[]): void {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO sync_logs (id, sync_run_id, timestamp, shopify_product_id, sku, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = d.transaction((rows: Omit<SyncLogEntry, "id">[]) => {
    for (const e of rows) {
      stmt.run(crypto.randomUUID(), e.syncRunId, e.timestamp, e.shopifyProductId, e.sku, e.action, e.field, e.oldValue, e.newValue);
    }
  });
  insertMany(entries);
}

export function getSyncLogs(syncRunId: string, limit = 500): SyncLogEntry[] {
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM sync_logs WHERE sync_run_id = ? ORDER BY timestamp DESC LIMIT ?`).all(syncRunId, limit) as Record<string, unknown>[];
  return rows.map(mapSyncLog);
}

function mapSyncLog(row: Record<string, unknown>): SyncLogEntry {
  return {
    id: row.id as string,
    syncRunId: row.sync_run_id as string,
    timestamp: row.timestamp as string,
    shopifyProductId: (row.shopify_product_id as string) || null,
    sku: row.sku as string,
    action: row.action as SyncLogEntry["action"],
    field: row.field as ChangeType,
    oldValue: (row.old_value as string) || null,
    newValue: (row.new_value as string) || null,
  };
}

// ─── Import Jobs ─────────────────────────────────────────────────────

const IMPORT_JOB_COLUMNS = new Set([
  "status", "content", "shopify_id", "error", "product_data", "group_key",
]);

export function upsertImportJob(job: { id: string; groupKey: string; productData: string; status: string; createdAt: string; updatedAt: string }): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO import_jobs (id, group_key, product_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_key) DO UPDATE SET product_data=excluded.product_data, status='pending', updated_at=excluded.updated_at`
  ).run(job.id, job.groupKey, job.productData, job.status, job.createdAt, job.updatedAt);
}

export function getImportJobs(): Record<string, unknown>[] {
  const d = getDb();
  return d.prepare(`SELECT * FROM import_jobs ORDER BY created_at DESC`).all() as Record<string, unknown>[];
}

export function getImportJob(jobId: string): Record<string, unknown> | null {
  const d = getDb();
  return (d.prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId) as Record<string, unknown>) || null;
}

export function updateImportJob(jobId: string, fields: Record<string, unknown>): void {
  const d = getDb();
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!IMPORT_JOB_COLUMNS.has(key)) {
      throw new Error(`Invalid column name: ${key}`);
    }
    sets.push(`${key} = ?`);
    args.push(value);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?`);
  args.push(new Date().toISOString());
  args.push(jobId);
  d.prepare(`UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}
