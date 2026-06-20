import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { startOfUtcDayEpoch, epochDaysAgo } from "@/lib/dashboard-metrics";

// Mirrors the queries in getDashboardSummary / getDashboardAlerts against an in-memory DB.
function setupDb(): Client {
  return createClient({ url: ":memory:" });
}

const NOW = new Date("2026-06-07T15:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const TODAY_START = startOfUtcDayEpoch(NOW);
const WEEK_AGO = epochDaysAgo(NOW, 7);

describe("dashboard summary queries (direct SQL)", () => {
  let db: Client;
  beforeEach(async () => {
    db = setupDb();
    await db.batch([
      `CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, old_price REAL, new_price REAL, old_qty INTEGER, new_qty INTEGER, change_type TEXT, detected_at INTEGER)`,
      `CREATE TABLE facebook_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, created_at INTEGER)`,
      `CREATE TABLE price_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, confirmed INTEGER DEFAULT 0)`,
      `CREATE TABLE cron_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, detail TEXT, ran_at INTEGER)`,
    ]);
  });
  afterEach(() => db.close());

  it("counts only new_product events from today", async () => {
    await db.batch([
      { sql: `INSERT INTO price_history (change_type, detected_at) VALUES ('new_product', ?)`, args: [TODAY_START + 100] },     // today
      { sql: `INSERT INTO price_history (change_type, detected_at) VALUES ('new_product', ?)`, args: [NOW_EPOCH] },             // today
      { sql: `INSERT INTO price_history (change_type, detected_at) VALUES ('new_product', ?)`, args: [TODAY_START - 1] },        // yesterday
      { sql: `INSERT INTO price_history (change_type, detected_at) VALUES ('price_drop', ?)`, args: [NOW_EPOCH] },               // not a new product
    ]);
    const r = await db.execute({ sql: `SELECT COUNT(*) AS c FROM price_history WHERE change_type = 'new_product' AND detected_at >= ?`, args: [TODAY_START] });
    expect(Number((r.rows[0] as unknown as Record<string, unknown>).c)).toBe(2);
  });

  it("counts drafts created within the last 7 days", async () => {
    await db.batch([
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('draft', ?)`, args: [NOW_EPOCH - 86400] },        // 1d ago
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('published', ?)`, args: [WEEK_AGO + 10] },         // just inside
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('draft', ?)`, args: [WEEK_AGO - 10] },             // just outside
    ]);
    const r = await db.execute({ sql: `SELECT COUNT(*) AS c FROM facebook_drafts WHERE created_at >= ?`, args: [WEEK_AGO] });
    expect(Number((r.rows[0] as unknown as Record<string, unknown>).c)).toBe(2);
  });

  it("counts only confirmed price alerts", async () => {
    await db.batch([
      `INSERT INTO price_alerts (confirmed) VALUES (1)`,
      `INSERT INTO price_alerts (confirmed) VALUES (1)`,
      `INSERT INTO price_alerts (confirmed) VALUES (0)`,
    ]);
    const r = await db.execute(`SELECT COUNT(*) AS c FROM price_alerts WHERE confirmed = 1`);
    expect(Number((r.rows[0] as unknown as Record<string, unknown>).c)).toBe(2);
  });

  it("returns the latest run per cron name (single-MAX bare-column rule)", async () => {
    await db.batch([
      { sql: `INSERT INTO cron_runs (name, status, ran_at) VALUES ('sync', 'success', ?)`, args: [NOW_EPOCH - 7200] },
      { sql: `INSERT INTO cron_runs (name, status, ran_at) VALUES ('sync', 'error', ?)`, args: [NOW_EPOCH - 60] },   // newest sync → wins
      { sql: `INSERT INTO cron_runs (name, status, ran_at) VALUES ('social', 'success', ?)`, args: [NOW_EPOCH - 3600] },
    ]);
    const r = await db.execute(`SELECT name, status, MAX(ran_at) AS ran_at FROM cron_runs GROUP BY name ORDER BY name ASC`);
    const rows = r.rows.map((x) => x as unknown as Record<string, unknown>);
    expect(rows.map((x) => x.name)).toEqual(["social", "sync"]);
    const sync = rows.find((x) => x.name === "sync")!;
    expect(sync.status).toBe("error");                 // status from the newest row
    expect(Number(sync.ran_at)).toBe(NOW_EPOCH - 60);
  });
});

describe("dashboard alerts queries (direct SQL)", () => {
  let db: Client;
  beforeEach(async () => {
    db = setupDb();
    await db.batch([
      `CREATE TABLE import_jobs (id TEXT PRIMARY KEY, group_key TEXT, product_data TEXT, status TEXT, error TEXT, updated_at TEXT)`,
      `CREATE TABLE facebook_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, created_at INTEGER)`,
      `CREATE TABLE feed_syncs (id INTEGER PRIMARY KEY AUTOINCREMENT, feed_type TEXT, item_count INTEGER, status TEXT, error TEXT, fetched_at INTEGER)`,
    ]);
  });
  afterEach(() => db.close());

  it("lists errored import jobs and extracts the SKU from product_data JSON", async () => {
    await db.batch([
      { sql: `INSERT INTO import_jobs (id, group_key, product_data, status, error, updated_at) VALUES ('j1', 'GRP-1', ?, 'error', 'boom', '2026-06-07')`, args: [JSON.stringify({ sku: "SKU-123", name: "Chair" })] },
      { sql: `INSERT INTO import_jobs (id, group_key, product_data, status, error, updated_at) VALUES ('j2', 'GRP-2', ?, 'completed', NULL, '2026-06-07')`, args: [JSON.stringify({ sku: "SKU-OK" })] },
    ]);
    const r = await db.execute(`SELECT id, group_key, product_data, error FROM import_jobs WHERE status = 'error'`);
    expect(r.rows.length).toBe(1);
    const row = r.rows[0] as unknown as Record<string, unknown>;
    const pd = JSON.parse(row.product_data as string) as { sku?: string };
    expect(pd.sku).toBe("SKU-123");
    expect(row.error).toBe("boom");
  });

  it("counts drafts pending more than 7 days", async () => {
    await db.batch([
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('draft', ?)`, args: [WEEK_AGO - 100] },      // stale
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('pending', ?)`, args: [WEEK_AGO - 100] },    // stale
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('draft', ?)`, args: [NOW_EPOCH] },            // fresh
      { sql: `INSERT INTO facebook_drafts (status, created_at) VALUES ('published', ?)`, args: [WEEK_AGO - 100] },   // not pending
    ]);
    const r = await db.execute({ sql: `SELECT COUNT(*) AS c FROM facebook_drafts WHERE status IN ('draft','pending') AND created_at < ?`, args: [WEEK_AGO] });
    expect(Number((r.rows[0] as unknown as Record<string, unknown>).c)).toBe(2);
  });

  // Mirror of getDashboardAlerts' feed query: last SUCCESS time/count + latest-attempt status.
  const feedSql = `SELECT f.feed_type AS feed_type,
      MAX(CASE WHEN f.status = 'success' THEN f.fetched_at END) AS last_success_at,
      (SELECT s.status FROM feed_syncs s WHERE s.feed_type = f.feed_type ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1) AS last_status,
      (SELECT s.item_count FROM feed_syncs s WHERE s.feed_type = f.feed_type AND s.status = 'success' ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1) AS item_count
    FROM feed_syncs f GROUP BY f.feed_type ORDER BY f.feed_type ASC`;

  it("reports the last SUCCESSFUL fetch per feed and flags a failing latest attempt", async () => {
    await db.batch([
      { sql: `INSERT INTO feed_syncs (feed_type, item_count, status, fetched_at) VALUES ('google', 100, 'success', ?)`, args: [NOW_EPOCH - 7200] },
      { sql: `INSERT INTO feed_syncs (feed_type, item_count, status, fetched_at) VALUES ('google', 120, 'success', ?)`, args: [NOW_EPOCH - 60] },   // newest success
      { sql: `INSERT INTO feed_syncs (feed_type, item_count, status, fetched_at) VALUES ('meta', NULL, 'error', ?)`, args: [NOW_EPOCH - 30] },       // only ever errored
      { sql: `INSERT INTO feed_syncs (feed_type, item_count, status, fetched_at) VALUES ('pinterest', 50, 'success', ?)`, args: [NOW_EPOCH - 7200] }, // old success
      { sql: `INSERT INTO feed_syncs (feed_type, item_count, status, fetched_at) VALUES ('pinterest', NULL, 'error', ?)`, args: [NOW_EPOCH - 10] },   // then failed
    ]);
    const rows = (await db.execute(feedSql)).rows.map((x) => x as unknown as Record<string, unknown>);
    const by = Object.fromEntries(rows.map((x) => [x.feed_type as string, x]));

    expect(Number(by.google.last_success_at)).toBe(NOW_EPOCH - 60);
    expect(Number(by.google.item_count)).toBe(120);
    expect(by.google.last_status).toBe("success");

    expect(by.meta.last_success_at).toBeNull();        // never succeeded → "jamais réussi"
    expect(by.meta.last_status).toBe("error");

    expect(Number(by.pinterest.last_success_at)).toBe(NOW_EPOCH - 7200); // keeps the old success time
    expect(by.pinterest.last_status).toBe("error");    // but flags the failing latest attempt
  });
});

// QA: price-floor auto-correction data contract (settings summary → priceFloor the panel renders,
// and the recent-changes feed excluding floor_correction rows). In-memory DB, no Shopify writes.
describe("price-floor auto-correction dashboard contract (direct SQL)", () => {
  let db: Client;
  beforeEach(async () => {
    db = setupDb();
    await db.batch([
      `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`,
      `CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, old_price REAL, new_price REAL, old_qty INTEGER, new_qty INTEGER, change_type TEXT, detected_at INTEGER, applied_to_shopify INTEGER DEFAULT 0)`,
      `CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT, image1 TEXT, shopify_product_id TEXT, shopify_handle TEXT)`,
    ]);
  });
  afterEach(() => db.close());

  // Mirror of _loadDashboardAlerts' priceFloor parse (database.ts).
  function parsePriceFloor(s: Record<string, unknown>) {
    return {
      belowFloorCount: Number(s.belowFloor) || 0,
      total: Number(s.total) || 0,
      corrected: Number(s.corrected) || 0,
      failed: Number(s.failed) || 0,
      deferred: Number(s.deferred) || 0,
      auditedAt: s.auditedAt != null ? Number(s.auditedAt) : null,
      topItems: Array.isArray(s.topItems) ? s.topItems : [],
    };
  }

  it("parses a current audit summary into the corrected/failed/deferred shape the panel reads", async () => {
    const summary = {
      auditedAt: NOW_EPOCH, total: 500, belowFloor: 3, corrected: 1, failed: 1, deferred: 1,
      topItems: [
        { sku: "BAD", shopify_price: 70, aosom_price: 90, gap: -20, corrected_price: 90, status: "failed", error: "429" },
        { sku: "OK", shopify_price: 80, aosom_price: 100, gap: -20, corrected_price: 100, status: "corrected" },
      ],
    };
    await db.execute({ sql: `INSERT INTO settings (key, value) VALUES ('price_audit_result', ?)`, args: [JSON.stringify(summary)] });

    const row = (await db.execute(`SELECT value FROM settings WHERE key = 'price_audit_result'`)).rows[0] as unknown as Record<string, unknown>;
    const pf = parsePriceFloor(JSON.parse(row.value as string));

    expect(pf).toMatchObject({ belowFloorCount: 3, corrected: 1, failed: 1, deferred: 1, total: 500 });
    expect(pf.topItems[0]).toMatchObject({ sku: "BAD", status: "failed" });
  });

  it("defaults corrected/failed/deferred to 0 for a legacy summary (pre auto-correction)", async () => {
    const legacy = { auditedAt: NOW_EPOCH, total: 500, belowFloor: 2, topItems: [{ sku: "X", shopify_price: 70, aosom_price: 90, gap: -20 }] };
    await db.execute({ sql: `INSERT INTO settings (key, value) VALUES ('price_audit_result', ?)`, args: [JSON.stringify(legacy)] });

    const row = (await db.execute(`SELECT value FROM settings WHERE key = 'price_audit_result'`)).rows[0] as unknown as Record<string, unknown>;
    const pf = parsePriceFloor(JSON.parse(row.value as string));

    // belowFloorCount survives so the panel's legacy fallback still raises an alert.
    expect(pf).toMatchObject({ belowFloorCount: 2, corrected: 0, failed: 0, deferred: 0 });
  });

  // Mirror of getRecentPriceChanges' query (database.ts), which now excludes floor_correction.
  const recentChangesSql = `SELECT ph.*, p.name FROM price_history ph LEFT JOIN products p ON ph.sku = p.sku
    WHERE ph.change_type != 'floor_correction' ORDER BY ph.detected_at DESC LIMIT ?`;

  it("keeps floor_correction rows out of the recent-changes feed (so they don't crowd real changes)", async () => {
    await db.batch([
      { sql: `INSERT INTO price_history (sku, change_type, detected_at, applied_to_shopify) VALUES ('A', 'floor_correction', ?, 1)`, args: [NOW_EPOCH - 5] },
      { sql: `INSERT INTO price_history (sku, change_type, detected_at, applied_to_shopify) VALUES ('B', 'floor_correction', ?, 0)`, args: [NOW_EPOCH - 4] },
      { sql: `INSERT INTO price_history (sku, change_type, detected_at) VALUES ('C', 'price_drop', ?)`, args: [NOW_EPOCH - 3] },
      { sql: `INSERT INTO price_history (sku, change_type, detected_at) VALUES ('D', 'price_increase', ?)`, args: [NOW_EPOCH - 2] },
    ]);
    const rows = (await db.execute({ sql: recentChangesSql, args: [20] })).rows.map((x) => x as unknown as Record<string, unknown>);

    expect(rows.map((r) => r.sku)).toEqual(["D", "C"]); // newest first, floor_correction excluded
    expect(rows.some((r) => r.change_type === "floor_correction")).toBe(false);
  });
});
