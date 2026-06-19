import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Exercises the SQL used by the back_in_stock_waitlist helpers (upsert / confirm /
// getPending / markNotified) against a fresh in-memory libsql DB — same approach
// as price-alerts-db.test.ts (the helpers go through a module singleton that
// can't point at :memory:). Covers the double opt-in gate (confirmed=1).

let db: Client;
const NOW = 1_000_000;

async function schema() {
  await db.batch([
    `CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT, price REAL, shopify_handle TEXT)`,
    `CREATE TABLE back_in_stock_waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, sku TEXT NOT NULL,
      shopify_product_id TEXT, created_at INTEGER DEFAULT (strftime('%s','now')),
      notified_at INTEGER, confirmed INTEGER DEFAULT 0, confirm_token TEXT, token_expires_at INTEGER,
      UNIQUE(email, sku))`,
  ]);
  await db.execute({ sql: `INSERT INTO products (sku, name, price, shopify_handle) VALUES (?, ?, ?, ?)`, args: ["ABC", "Chaise", 100, "chair"] });
}

const UPSERT = `INSERT INTO back_in_stock_waitlist (email, sku, shopify_product_id, created_at, notified_at, confirmed, confirm_token, token_expires_at)
  VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
  ON CONFLICT(email, sku) DO UPDATE SET
    shopify_product_id = excluded.shopify_product_id, created_at = excluded.created_at,
    notified_at = NULL, confirmed = 0, confirm_token = excluded.confirm_token,
    token_expires_at = excluded.token_expires_at`;

const PENDING = `SELECT id, email FROM back_in_stock_waitlist WHERE sku = ? AND notified_at IS NULL AND confirmed = 1`;

const CONFIRM_FIND = `SELECT w.id, w.sku, p.shopify_handle FROM back_in_stock_waitlist w
  LEFT JOIN products p ON p.sku = w.sku
  WHERE w.confirm_token = ? AND w.confirmed = 0 AND w.token_expires_at > ?`;

describe("back_in_stock_waitlist SQL (double opt-in)", () => {
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await schema();
  });
  afterEach(() => db.close());

  it("upsert stores unconfirmed; re-signup refreshes fields + resets confirmed + new token", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", "gid-1", 1, "tok-1", NOW + 86400] });
    await db.execute(`UPDATE back_in_stock_waitlist SET confirmed = 1, notified_at = 555 WHERE email='a@b.com' AND sku='ABC'`);
    // re-signup
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", "gid-2", 2, "tok-2", NOW + 86400] });

    const rows = (await db.execute(`SELECT shopify_product_id, created_at, notified_at, confirmed, confirm_token FROM back_in_stock_waitlist`)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].shopify_product_id).toBe("gid-2");
    expect(Number(rows[0].created_at)).toBe(2);
    expect(rows[0].notified_at).toBeNull();
    expect(Number(rows[0].confirmed)).toBe(0); // reset → must re-confirm
    expect(rows[0].confirm_token).toBe("tok-2");
  });

  it("getPending requires confirmed=1 (unconfirmed signups are never emailed)", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 1, "tok", NOW + 86400] });
    expect((await db.execute({ sql: PENDING, args: ["ABC"] })).rows.length).toBe(0); // unconfirmed
    await db.execute(`UPDATE back_in_stock_waitlist SET confirmed = 1 WHERE email='a@b.com'`);
    expect((await db.execute({ sql: PENDING, args: ["ABC"] })).rows.length).toBe(1); // confirmed
  });

  it("confirm: valid non-expired token marks confirmed + clears token (single use)", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 1, "tok-xyz", NOW + 86400] });
    const found = await db.execute({ sql: CONFIRM_FIND, args: ["tok-xyz", NOW] });
    expect(found.rows.length).toBe(1);
    expect(found.rows[0].shopify_handle).toBe("chair");
    await db.execute({ sql: `UPDATE back_in_stock_waitlist SET confirmed = 1, confirm_token = NULL, token_expires_at = NULL WHERE id = ?`, args: [Number(found.rows[0].id)] });
    // token no longer usable
    expect((await db.execute({ sql: CONFIRM_FIND, args: ["tok-xyz", NOW] })).rows.length).toBe(0);
    expect(Number((await db.execute(`SELECT confirmed FROM back_in_stock_waitlist`)).rows[0].confirmed)).toBe(1);
  });

  it("confirm: an expired token is not accepted", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 1, "old-tok", NOW - 1] });
    expect((await db.execute({ sql: CONFIRM_FIND, args: ["old-tok", NOW] })).rows.length).toBe(0);
  });

  it("getPending returns only confirmed + un-notified rows for the SKU", async () => {
    // a@b.com confirmed+pending, c@d.com confirmed+notified, e@f.com confirmed but other sku, g@h.com unconfirmed
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 1, "t1", NOW + 86400] });
    await db.execute({ sql: UPSERT, args: ["c@d.com", "ABC", null, 1, "t2", NOW + 86400] });
    await db.execute({ sql: UPSERT, args: ["e@f.com", "XYZ", null, 1, "t3", NOW + 86400] });
    await db.execute({ sql: UPSERT, args: ["g@h.com", "ABC", null, 1, "t4", NOW + 86400] });
    await db.execute(`UPDATE back_in_stock_waitlist SET confirmed = 1 WHERE email IN ('a@b.com','c@d.com','e@f.com')`);
    await db.execute(`UPDATE back_in_stock_waitlist SET notified_at = ${NOW} WHERE email='c@d.com'`);
    const pending = (await db.execute({ sql: PENDING, args: ["ABC"] })).rows;
    expect(pending.map((r) => String(r.email))).toEqual(["a@b.com"]);
  });

  it("markNotified stamps notified_at for the given id only", async () => {
    await db.execute({ sql: UPSERT, args: ["a@b.com", "ABC", null, 1, "t1", NOW + 86400] });
    await db.execute({ sql: UPSERT, args: ["c@d.com", "ABC", null, 1, "t2", NOW + 86400] });
    await db.execute(`UPDATE back_in_stock_waitlist SET confirmed = 1 WHERE sku='ABC'`);
    const ids = (await db.execute({ sql: PENDING, args: ["ABC"] })).rows.map((r) => Number(r.id));
    await db.execute({ sql: `UPDATE back_in_stock_waitlist SET notified_at = ? WHERE id IN (?)`, args: [NOW, ids[0]] });
    const stillPending = (await db.execute({ sql: PENDING, args: ["ABC"] })).rows.map((r) => Number(r.id));
    expect(stillPending).not.toContain(ids[0]);
    expect(stillPending.length).toBe(1);
  });
});
