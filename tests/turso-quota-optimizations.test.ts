import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { PRODUCT_HAS_DISCOUNT_RECOMPUTE_SQL } from "@/lib/catalog-filters";

// Mirrors rebuildDiscountFlags()'s two-statement, write-only-changed-rows form.
function recomputeDiscountFlags(db: Client) {
  return db.batch([
    { sql: `UPDATE products SET has_discount = 1 WHERE has_discount = 0 AND ${PRODUCT_HAS_DISCOUNT_RECOMPUTE_SQL}`, args: [] },
    { sql: `UPDATE products SET has_discount = 0 WHERE has_discount = 1 AND NOT (${PRODUCT_HAS_DISCOUNT_RECOMPUTE_SQL})`, args: [] },
  ], "write");
}

// These mirror the SQL run by database.ts:rebuildDiscountFlags() and
// purgeOldCronLogs() against an in-memory DB — the same "mirror the query"
// approach as dashboard-db.test.ts (the real functions use a module-level
// libsql singleton tied to env, so we exercise the SQL directly).

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const DAY = 86400;

describe("rebuildDiscountFlags recompute SQL (precomputed has_discount)", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.batch([
      `CREATE TABLE products (sku TEXT PRIMARY KEY, price REAL, has_discount INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, old_price REAL, change_type TEXT, detected_at INTEGER)`,
    ]);
    await db.batch([
      // current prices
      { sql: `INSERT INTO products (sku, price) VALUES ('DROP', 80)`, args: [] },       // last move = drop from 100 → on sale
      { sql: `INSERT INTO products (sku, price) VALUES ('UP', 80)`, args: [] },         // last move = increase → not on sale
      { sql: `INSERT INTO products (sku, price) VALUES ('DROP_THEN_UP', 80)`, args: [] }, // older drop, newer increase → latest wins → not on sale
      { sql: `INSERT INTO products (sku, price) VALUES ('NOHIST', 80)`, args: [] },     // no price history → not on sale
      { sql: `INSERT INTO products (sku, price) VALUES ('STOCK', 80)`, args: [] },      // only stock_change rows → not on sale
      { sql: `INSERT INTO products (sku, price) VALUES ('OLD_DROP', 90)`, args: [] },   // drop long ago, still on sale
      // history (old_price = price BEFORE the change)
      { sql: `INSERT INTO price_history (sku, old_price, change_type, detected_at) VALUES ('DROP', 100, 'price_drop', ?)`, args: [NOW_EPOCH - DAY] },
      { sql: `INSERT INTO price_history (sku, old_price, change_type, detected_at) VALUES ('UP', 50, 'price_increase', ?)`, args: [NOW_EPOCH - DAY] },
      { sql: `INSERT INTO price_history (sku, old_price, change_type, detected_at) VALUES ('DROP_THEN_UP', 120, 'price_drop', ?)`, args: [NOW_EPOCH - 5 * DAY] },
      { sql: `INSERT INTO price_history (sku, old_price, change_type, detected_at) VALUES ('DROP_THEN_UP', 70, 'price_increase', ?)`, args: [NOW_EPOCH - DAY] },
      { sql: `INSERT INTO price_history (sku, old_price, change_type, detected_at) VALUES ('STOCK', NULL, 'stock_change', ?)`, args: [NOW_EPOCH - DAY] },
      { sql: `INSERT INTO price_history (sku, old_price, change_type, detected_at) VALUES ('OLD_DROP', 120, 'price_drop', ?)`, args: [NOW_EPOCH - 400 * DAY] },
    ]);
  });
  afterEach(() => db.close());

  it("sets has_discount from the most recent price move per SKU", async () => {
    await recomputeDiscountFlags(db);
    const r = await db.execute(`SELECT sku, has_discount FROM products ORDER BY sku`);
    const flags = Object.fromEntries(
      r.rows.map((row) => {
        const o = row as unknown as Record<string, unknown>;
        return [o.sku as string, Number(o.has_discount)];
      })
    );
    expect(flags).toEqual({
      DROP: 1,
      DROP_THEN_UP: 0, // latest move is an increase → no active rabais
      NOHIST: 0,
      OLD_DROP: 1, // still on sale even though the drop is >1y old
      STOCK: 0, // stock-only history is excluded from the discount signal
      UP: 0,
    });
  });

  it("is idempotent and clears a stale flag when the discount is gone", async () => {
    // Pretend a prior run had flagged UP as discounted; recompute must reset it to 0.
    await db.execute(`UPDATE products SET has_discount = 1 WHERE sku = 'UP'`);
    await recomputeDiscountFlags(db);
    const r = await db.execute(`SELECT has_discount FROM products WHERE sku = 'UP'`);
    expect(Number((r.rows[0] as unknown as Record<string, unknown>).has_discount)).toBe(0);
  });
});

describe("purgeOldCronLogs SQL (cron_runs.ran_at + feed_syncs.fetched_at)", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.batch([
      `CREATE TABLE cron_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, detail TEXT, ran_at INTEGER NOT NULL)`,
      `CREATE TABLE feed_syncs (id INTEGER PRIMARY KEY AUTOINCREMENT, feed_type TEXT, item_count INTEGER, status TEXT, error TEXT, fetched_at INTEGER NOT NULL)`,
    ]);
    await db.batch([
      { sql: `INSERT INTO cron_runs (name, status, ran_at) VALUES ('sync', 'success', ?)`, args: [NOW_EPOCH - 40 * DAY] },   // purge (old, not latest 'sync')
      { sql: `INSERT INTO cron_runs (name, status, ran_at) VALUES ('sync', 'success', ?)`, args: [NOW_EPOCH - 10 * DAY] },   // keep (recent)
      { sql: `INSERT INTO cron_runs (name, status, ran_at) VALUES ('social', 'success', ?)`, args: [NOW_EPOCH - 40 * DAY] }, // keep (old but latest for 'social')
      { sql: `INSERT INTO feed_syncs (feed_type, status, fetched_at) VALUES ('google', 'success', ?)`, args: [NOW_EPOCH - 40 * DAY] }, // purge (old, not latest 'google')
      { sql: `INSERT INTO feed_syncs (feed_type, status, fetched_at) VALUES ('google', 'success', ?)`, args: [NOW_EPOCH - 5 * DAY] },  // keep (recent)
      { sql: `INSERT INTO feed_syncs (feed_type, status, fetched_at) VALUES ('pinterest', 'error', ?)`, args: [NOW_EPOCH - 40 * DAY] }, // keep (old but latest for 'pinterest')
    ]);
  });
  afterEach(() => db.close());

  it("purges old rows but keeps the latest per name/feed_type even when older than the window", async () => {
    const [cron, feeds] = await db.batch([
      {
        sql: `DELETE FROM cron_runs WHERE ran_at < unixepoch('now', ?)
                AND id NOT IN (SELECT MAX(id) FROM cron_runs GROUP BY name)`,
        args: ["-30 days"],
      },
      {
        sql: `DELETE FROM feed_syncs WHERE fetched_at < unixepoch('now', ?)
                AND id NOT IN (SELECT MAX(id) FROM feed_syncs GROUP BY feed_type)`,
        args: ["-30 days"],
      },
    ], "write");
    expect(Number(cron.rowsAffected)).toBe(1);   // only the old non-latest 'sync' row
    expect(Number(feeds.rowsAffected)).toBe(1);  // only the old non-latest 'google' row

    // 'social' (old but latest) and 'pinterest' (old but latest) survive.
    const socialLeft = await db.execute(`SELECT COUNT(*) AS c FROM cron_runs WHERE name = 'social'`);
    expect(Number((socialLeft.rows[0] as unknown as Record<string, unknown>).c)).toBe(1);
    const pinLeft = await db.execute(`SELECT COUNT(*) AS c FROM feed_syncs WHERE feed_type = 'pinterest'`);
    expect(Number((pinLeft.rows[0] as unknown as Record<string, unknown>).c)).toBe(1);

    const cronLeft = await db.execute(`SELECT COUNT(*) AS c FROM cron_runs`);
    const feedsLeft = await db.execute(`SELECT COUNT(*) AS c FROM feed_syncs`);
    expect(Number((cronLeft.rows[0] as unknown as Record<string, unknown>).c)).toBe(2);  // 'sync' recent + 'social' latest
    expect(Number((feedsLeft.rows[0] as unknown as Record<string, unknown>).c)).toBe(2); // 'google' recent + 'pinterest' latest
  });
});
