import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Mirrors markPriceChangeAppliedBySku(sku, newPrice)'s SQL against an in-memory DB.
// It flags the newest un-applied price-change row (price_drop/price_increase) for a
// SKU WHOSE new_price equals the just-pushed price — matching on new_price (not just
// SKU) keeps it correct when Phase 2 pushes without a fresh record and when a
// floor-correction has no recorded row.
const MARK_SQL = `UPDATE price_history SET applied_to_shopify = 1
  WHERE id = (
    SELECT MAX(id) FROM price_history
    WHERE sku = ? AND change_type IN ('price_drop', 'price_increase')
      AND applied_to_shopify = 0 AND ABS(new_price - ?) < 0.01
  )`;

describe("markPriceChangeAppliedBySku SQL (match on SKU + new_price)", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, old_price REAL, new_price REAL, change_type TEXT, applied_to_shopify INTEGER DEFAULT 0)`
    );
    await db.batch([
      `INSERT INTO price_history (sku, new_price, change_type, applied_to_shopify) VALUES ('A', 70.00, 'price_increase', 0)`, // id 1 — different price
      `INSERT INTO price_history (sku, new_price, change_type, applied_to_shopify) VALUES ('A', 0,     'stock_change',   0)`, // id 2 — ignored type
      `INSERT INTO price_history (sku, new_price, change_type, applied_to_shopify) VALUES ('A', 85.99, 'price_increase', 0)`, // id 3 — the pushed price
      `INSERT INTO price_history (sku, new_price, change_type, applied_to_shopify) VALUES ('B', 85.99, 'price_drop',     0)`, // id 4 — other SKU
    ]);
  });
  afterEach(() => db.close());

  const applied = async (id: number) =>
    Number((await db.execute({ sql: `SELECT applied_to_shopify FROM price_history WHERE id = ?`, args: [id] }))
      .rows[0].applied_to_shopify);

  it("marks the row whose new_price matches the pushed price, for that SKU only", async () => {
    const r = await db.execute({ sql: MARK_SQL, args: ["A", 85.99] });
    expect(Number(r.rowsAffected)).toBe(1);
    expect(await applied(3)).toBe(1); // matched price → marked
    expect(await applied(1)).toBe(0); // different price untouched
    expect(await applied(2)).toBe(0); // stock_change never marked
    expect(await applied(4)).toBe(0); // other SKU untouched
  });

  it("no-ops (0 rows) when no recorded row matches the pushed price (e.g. a floor-correction)", async () => {
    const r = await db.execute({ sql: MARK_SQL, args: ["A", 999.99] });
    expect(Number(r.rowsAffected)).toBe(0);
    for (const id of [1, 2, 3, 4]) expect(await applied(id)).toBe(0);
  });
});
