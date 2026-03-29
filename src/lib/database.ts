import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
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

function initSchema(db: Database.Database) {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS catalog_snapshots (
      sku TEXT PRIMARY KEY,
      name TEXT,
      price REAL,
      qty INTEGER,
      color TEXT,
      product_type TEXT,
      psin TEXT,
      image TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      price REAL NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_snapshots (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      qty INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_logs_run ON sync_logs(sync_run_id);
    CREATE INDEX IF NOT EXISTS idx_sync_logs_sku ON sync_logs(sku);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_date ON sync_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_catalog_psin ON catalog_snapshots(psin);
    CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history(sku);
    CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_stock_snapshots_sku ON stock_snapshots(sku);
    CREATE INDEX IF NOT EXISTS idx_stock_snapshots_date ON stock_snapshots(recorded_at);
  `);
}

// --- Sync Runs ---

export async function createSyncRun(): Promise<SyncRun> {
  const d = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  d.prepare(`INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`).run(id, now);
  return { id, startedAt: now, completedAt: null, status: "running", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 0, errorMessages: [] };
}

export async function completeSyncRun(
  id: string,
  stats: { status: "completed" | "failed"; totalProducts: number; created: number; updated: number; archived: number; errors: number; errorMessages: string[] }
) {
  const d = getDb();
  d.prepare(`UPDATE sync_runs SET completed_at=?, status=?, total_products=?, created=?, updated=?, archived=?, errors=?, error_messages=? WHERE id=?`)
    .run(new Date().toISOString(), stats.status, stats.totalProducts, stats.created, stats.updated, stats.archived, stats.errors, JSON.stringify(stats.errorMessages), id);
}

export async function getSyncRuns(limit = 20): Promise<SyncRun[]> {
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  return rows.map(mapSyncRun);
}

export async function getLatestSyncRun(): Promise<SyncRun | null> {
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

// --- Sync Logs ---

export async function addSyncLogsBatch(entries: Omit<SyncLogEntry, "id">[]) {
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

export async function getSyncLogs(syncRunId: string, limit = 500): Promise<SyncLogEntry[]> {
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

// --- Catalog Snapshots ---

export async function refreshCatalogSnapshots(
  products: { sku: string; name: string; price: number; qty: number; color: string; productType: string; psin: string; image: string }[]
) {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`DELETE FROM catalog_snapshots`).run();
  const stmt = d.prepare(`INSERT INTO catalog_snapshots (sku, name, price, qty, color, product_type, psin, image, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMany = d.transaction((rows: typeof products) => {
    for (const p of rows) {
      stmt.run(p.sku, p.name, p.price, p.qty, p.color, p.productType, p.psin, p.image, now);
    }
  });
  insertMany(products);
}

export async function getCatalogProducts(filters: {
  productType?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  page?: number;
  limit?: number;
}): Promise<{ products: Record<string, unknown>[]; total: number; productTypes: { type: string; count: number }[] }> {
  const d = getDb();
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filters.productType) { conditions.push(`cs.product_type LIKE ?`); args.push(`${filters.productType}%`); }
  if (filters.search) { conditions.push(`(cs.name LIKE ? OR cs.sku LIKE ?)`); args.push(`%${filters.search}%`, `%${filters.search}%`); }
  if (filters.minPrice !== undefined) { conditions.push(`cs.price >= ?`); args.push(filters.minPrice); }
  if (filters.maxPrice !== undefined) { conditions.push(`cs.price <= ?`); args.push(filters.maxPrice); }
  if (filters.inStock) { conditions.push(`cs.qty > 0`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = filters.page || 1;
  const limit = Math.min(filters.limit || 50, 200);
  const offset = (page - 1) * limit;

  const total = (d.prepare(`SELECT COUNT(*) as cnt FROM catalog_snapshots cs ${where}`).get(...args) as { cnt: number }).cnt;

  const products = d.prepare(
    `SELECT cs.*, ij.status as import_status,
      (SELECT ph2.price FROM price_history ph2 WHERE ph2.sku = cs.sku ORDER BY ph2.recorded_at DESC LIMIT 1 OFFSET 1) as prev_price
    FROM catalog_snapshots cs
    LEFT JOIN import_jobs ij ON cs.psin = ij.group_key
    ${where} ORDER BY cs.name LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as Record<string, unknown>[];

  const typeRows = d.prepare(
    `SELECT product_type, COUNT(*) as cnt FROM catalog_snapshots WHERE product_type != '' GROUP BY product_type ORDER BY product_type`
  ).all() as { product_type: string; cnt: number }[];

  const typeCounts = new Map<string, number>();
  for (const row of typeRows) {
    const parts = row.product_type.split(">").map((s) => s.trim());
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

// --- Import Jobs ---

export async function upsertImportJob(job: { id: string; groupKey: string; productData: string; status: string; createdAt: string; updatedAt: string }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO import_jobs (id, group_key, product_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_key) DO UPDATE SET product_data=excluded.product_data, status='pending', updated_at=excluded.updated_at`
  ).run(job.id, job.groupKey, job.productData, job.status, job.createdAt, job.updatedAt);
}

export async function getImportJobs(): Promise<Record<string, unknown>[]> {
  const d = getDb();
  return d.prepare(`SELECT * FROM import_jobs ORDER BY created_at DESC`).all() as Record<string, unknown>[];
}

export async function getImportJob(jobId: string): Promise<Record<string, unknown> | null> {
  const d = getDb();
  return (d.prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId) as Record<string, unknown>) || null;
}

export async function updateImportJob(jobId: string, fields: Record<string, unknown>) {
  const d = getDb();
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    args.push(value);
  }
  sets.push(`updated_at = ?`);
  args.push(new Date().toISOString());
  args.push(jobId);
  d.prepare(`UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

// --- Price History ---

export async function recordPriceSnapshots(products: { sku: string; price: number }[]) {
  const d = getDb();
  const now = new Date().toISOString();
  const stmt = d.prepare(`INSERT INTO price_history (id, sku, price, recorded_at) VALUES (?, ?, ?, ?)`);
  const insertMany = d.transaction((rows: typeof products) => {
    for (const p of rows) {
      stmt.run(crypto.randomUUID(), p.sku, p.price, now);
    }
  });
  insertMany(products);
}

export async function getPriceChanges(limit = 50): Promise<{
  sku: string; name: string; image: string; oldPrice: number; newPrice: number; change: number; pct: number; recordedAt: string;
}[]> {
  const d = getDb();
  // Find SKUs where the latest price differs from the previous price
  const rows = d.prepare(`
    WITH ranked AS (
      SELECT ph.sku, ph.price, ph.recorded_at,
             ROW_NUMBER() OVER (PARTITION BY ph.sku ORDER BY ph.recorded_at DESC) as rn
      FROM price_history ph
    )
    SELECT
      curr.sku,
      cs.name,
      cs.image,
      prev.price as old_price,
      curr.price as new_price,
      (curr.price - prev.price) as change,
      ROUND((curr.price - prev.price) / prev.price * 100, 1) as pct,
      curr.recorded_at
    FROM ranked curr
    JOIN ranked prev ON curr.sku = prev.sku AND prev.rn = 2
    LEFT JOIN catalog_snapshots cs ON curr.sku = cs.sku
    WHERE curr.rn = 1 AND curr.price != prev.price
    ORDER BY ABS(curr.price - prev.price) DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    sku: r.sku as string,
    name: (r.name as string) || r.sku as string,
    image: (r.image as string) || "",
    oldPrice: r.old_price as number,
    newPrice: r.new_price as number,
    change: r.change as number,
    pct: r.pct as number,
    recordedAt: r.recorded_at as string,
  }));
}

// --- Stock Velocity ---

export async function recordStockSnapshots(products: { sku: string; qty: number }[]) {
  const d = getDb();
  const now = new Date().toISOString();
  const stmt = d.prepare(`INSERT INTO stock_snapshots (id, sku, qty, recorded_at) VALUES (?, ?, ?, ?)`);
  const insertMany = d.transaction((rows: typeof products) => {
    for (const p of rows) {
      stmt.run(crypto.randomUUID(), p.sku, p.qty, now);
    }
  });
  insertMany(products);
}

export async function getTopSellers(limit = 30): Promise<{
  sku: string; name: string; image: string; color: string; productType: string; price: number;
  currentQty: number; soldPerDay: number; daysTracked: number;
}[]> {
  const d = getDb();
  // Calculate stock velocity: (first_qty - latest_qty) / days_between
  const rows = d.prepare(`
    WITH first_snap AS (
      SELECT sku, qty, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY sku ORDER BY recorded_at ASC) as rn
      FROM stock_snapshots
    ),
    last_snap AS (
      SELECT sku, qty, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY sku ORDER BY recorded_at DESC) as rn
      FROM stock_snapshots
    )
    SELECT
      f.sku,
      cs.name,
      cs.image,
      cs.color,
      cs.product_type,
      cs.price,
      l.qty as current_qty,
      CASE
        WHEN julianday(l.recorded_at) - julianday(f.recorded_at) > 0
        THEN ROUND(CAST(f.qty - l.qty AS REAL) / (julianday(l.recorded_at) - julianday(f.recorded_at)), 1)
        ELSE 0
      END as sold_per_day,
      ROUND(julianday(l.recorded_at) - julianday(f.recorded_at)) as days_tracked
    FROM first_snap f
    JOIN last_snap l ON f.sku = l.sku AND l.rn = 1
    LEFT JOIN catalog_snapshots cs ON f.sku = cs.sku
    WHERE f.rn = 1
      AND f.qty > l.qty
      AND julianday(l.recorded_at) - julianday(f.recorded_at) >= 0
    ORDER BY sold_per_day DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    sku: r.sku as string,
    name: (r.name as string) || r.sku as string,
    image: (r.image as string) || "",
    color: (r.color as string) || "",
    productType: (r.product_type as string) || "",
    price: (r.price as number) || 0,
    currentQty: r.current_qty as number,
    soldPerDay: r.sold_per_day as number,
    daysTracked: (r.days_tracked as number) || 0,
  }));
}
