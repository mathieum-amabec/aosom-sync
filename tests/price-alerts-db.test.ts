import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Exercises the SQL used by the price_alerts helpers (upsert / triggered /
// confirm) against a fresh in-memory libsql DB — same approach as
// database.test.ts (the helpers go through a module singleton that can't point
// at :memory:). Covers the double opt-in gate added in this branch.

let db: Client;
const NOW = 1_000_000;

async function schema() {
  await db.batch([
    `CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT, price REAL, shopify_handle TEXT)`,
    `CREATE TABLE price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, sku TEXT NOT NULL,
      shopify_product_id TEXT, price_at_signup REAL NOT NULL, created_at INTEGER NOT NULL,
      notified_at INTEGER, confirmed INTEGER DEFAULT 0, confirm_token TEXT, token_expires_at INTEGER,
      UNIQUE(email, sku))`,
  ]);
}

const UPSERT = `INSERT INTO price_alerts (email, sku, shopify_product_id, price_at_signup, created_at, notified_at, confirmed, confirm_token, token_expires_at)
  VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
  ON CONFLICT(email, sku) DO UPDATE SET
    price_at_signup = excluded.price_at_signup, shopify_product_id = excluded.shopify_product_id,
    created_at = excluded.created_at, notified_at = NULL, confirmed = 0,
    confirm_token = excluded.confirm_token, token_expires_at = excluded.token_expires_at`;

const TRIGGERED = `SELECT a.id FROM price_alerts a JOIN products p ON p.sku = a.sku
  WHERE a.notified_at IS NULL AND a.confirmed = 1 AND p.price < a.price_at_signup`;

const CONFIRM_FIND = `SELECT a.id, a.sku, p.shopify_handle FROM price_alerts a
  LEFT JOIN products p ON p.sku = a.sku
  WHERE a.confirm_token = ? AND a.confirmed = 0 AND a.token_expires_at > ?`;

describe("price_alerts SQL (double opt-in)", () => {
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await schema();
    await db.execute({ sql: `INSERT INTO products (sku, name, price, shopify_handle) VALUES (?, ?, ?, ?)`, args: ["ABC", "Chair", 100, "chair"] });
  });
  afterEach(() => db.close());

  it("upsert stores unconfirmed with a token; re-signup resets price/notified/confirmed + new token", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", "gid", 100, 1, "tok-1", NOW + 86400] });
    await db.execute(`UPDATE price_alerts SET confirmed = 1, notified_at = 123 WHERE email='a@b.com' AND sku='ABC'`);
    // re-signup
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", "gid", 90, 2, "tok-2", NOW + 86400] });

    const rows = (await db.execute(`SELECT price_at_signup, notified_at, confirmed, confirm_token FROM price_alerts`)).rows;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].price_at_signup)).toBe(90);
    expect(rows[0].notified_at).toBeNull();
    expect(Number(rows[0].confirmed)).toBe(0); // reset → must re-confirm
    expect(rows[0].confirm_token).toBe("tok-2");
  });

  it("triggered requires confirmed=1 (unconfirmed signups are never emailed)", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 100, 1, "tok", NOW + 86400] });
    await db.execute(`UPDATE products SET price = 80 WHERE sku='ABC'`); // dropped, but unconfirmed
    expect((await db.execute(TRIGGERED)).rows.length).toBe(0);

    await db.execute(`UPDATE price_alerts SET confirmed = 1 WHERE email='a@b.com'`);
    expect((await db.execute(TRIGGERED)).rows.length).toBe(1);
  });

  it("confirm: valid non-expired token marks confirmed + clears token (single use)", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 100, 1, "tok-xyz", NOW + 86400] });
    const found = await db.execute({ sql: CONFIRM_FIND, args: ["tok-xyz", NOW] });
    expect(found.rows.length).toBe(1);
    expect(found.rows[0].shopify_handle).toBe("chair");
    await db.execute({ sql: `UPDATE price_alerts SET confirmed = 1, confirm_token = NULL, token_expires_at = NULL WHERE id = ?`, args: [Number(found.rows[0].id)] });

    // token no longer usable
    expect((await db.execute({ sql: CONFIRM_FIND, args: ["tok-xyz", NOW] })).rows.length).toBe(0);
    expect(Number((await db.execute(`SELECT confirmed FROM price_alerts`)).rows[0].confirmed)).toBe(1);
  });

  it("confirm: an expired token is not accepted", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 100, 1, "old-tok", NOW - 1] });
    expect((await db.execute({ sql: CONFIRM_FIND, args: ["old-tok", NOW] })).rows.length).toBe(0);
  });
});
