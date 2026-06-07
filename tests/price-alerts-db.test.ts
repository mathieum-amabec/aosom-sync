import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Exercises the exact SQL used by upsertPriceAlert / getTriggeredPriceAlerts /
// markPriceAlertsNotified against a fresh in-memory libsql DB (the database.ts
// helpers go through a module singleton that can't point at :memory:, so we test
// the SQL contract directly — same approach as database.test.ts).

let db: Client;

async function schema() {
  await db.batch([
    `CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT, price REAL, shopify_handle TEXT)`,
    `CREATE TABLE price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, sku TEXT NOT NULL,
      shopify_product_id TEXT, price_at_signup REAL NOT NULL, created_at INTEGER NOT NULL,
      notified_at INTEGER, UNIQUE(email, sku))`,
  ]);
}

const UPSERT = `INSERT INTO price_alerts (email, sku, shopify_product_id, price_at_signup, created_at, notified_at)
  VALUES (?, ?, ?, ?, ?, NULL)
  ON CONFLICT(email, sku) DO UPDATE SET
    price_at_signup = excluded.price_at_signup,
    shopify_product_id = excluded.shopify_product_id,
    created_at = excluded.created_at,
    notified_at = NULL`;

const TRIGGERED = `SELECT a.id, a.email, a.sku, a.price_at_signup, p.price AS current_price
  FROM price_alerts a JOIN products p ON p.sku = a.sku
  WHERE a.notified_at IS NULL AND p.price < a.price_at_signup`;

describe("price_alerts SQL", () => {
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await schema();
    await db.execute({ sql: `INSERT INTO products (sku, name, price, shopify_handle) VALUES (?, ?, ?, ?)`, args: ["ABC", "Chair", 100, "chair"] });
  });
  afterEach(() => db.close());

  it("upsert resets price + notified_at on re-signup (UNIQUE email+sku)", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", "gid", 100, 1] });
    // simulate a prior notification
    await db.execute(`UPDATE price_alerts SET notified_at = 123 WHERE email='a@b.com' AND sku='ABC'`);
    // re-signup at a new (lower) reference price
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", "gid", 90, 2] });

    const rows = (await db.execute(`SELECT price_at_signup, notified_at, created_at FROM price_alerts`)).rows;
    expect(rows.length).toBe(1); // upsert, not a second row
    expect(Number(rows[0].price_at_signup)).toBe(90);
    expect(rows[0].notified_at).toBeNull(); // reset so they can be alerted again
    expect(Number(rows[0].created_at)).toBe(2);
  });

  it("triggers only when current price < signup price and not yet notified", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 100, 1] });
    // price still 100 → not triggered
    expect((await db.execute(TRIGGERED)).rows.length).toBe(0);

    // drop price to 80 → triggered
    await db.execute(`UPDATE products SET price = 80 WHERE sku='ABC'`);
    const triggered = (await db.execute(TRIGGERED)).rows;
    expect(triggered.length).toBe(1);
    expect(Number(triggered[0].current_price)).toBe(80);

    // mark notified → excluded
    await db.execute({ sql: `UPDATE price_alerts SET notified_at = ? WHERE id IN (?)`, args: [999, Number(triggered[0].id)] });
    expect((await db.execute(TRIGGERED)).rows.length).toBe(0);
  });

  it("excludes alerts whose SKU is no longer in the catalog (inner join)", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "GONE", null, 100, 1] });
    await db.execute(`UPDATE products SET price = 1 WHERE sku='ABC'`);
    expect((await db.execute(TRIGGERED)).rows.length).toBe(0);
  });
});
