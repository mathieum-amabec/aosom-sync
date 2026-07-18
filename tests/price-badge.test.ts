import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { decidePriceBadge } from "@/lib/database";

// decidePriceBadge is the pure branch of getPriceBadge (best_30d / price_drop /
// null). The SQL block below mirrors the queries getPriceBadge runs, so the
// (current, min30, reference) triple it feeds decidePriceBadge is also covered.

describe("decidePriceBadge (pure)", () => {
  it("best_30d when current equals the 30-day minimum (ties win)", () => {
    // dropped 120 → 100, 100 is the low
    expect(decidePriceBadge(100, 100, 120)).toBe("best_30d");
  });

  it("best_30d when current is below everything seen", () => {
    expect(decidePriceBadge(90, 100, 120)).toBe("best_30d");
  });

  it("price_drop when current is below reference but not the window low", () => {
    // was 120 thirty days ago, dipped to 100, now 110 → dropped vs reference, not the low
    expect(decidePriceBadge(110, 100, 120)).toBe("price_drop");
  });

  it("null when current sits at/above the reference and is not the low", () => {
    expect(decidePriceBadge(120, 100, 120)).toBeNull();
    expect(decidePriceBadge(130, 100, 120)).toBeNull();
  });

  it("null when there is no recorded activity in the window", () => {
    expect(decidePriceBadge(100, null, null)).toBeNull();
  });

  it("best_30d with only a reference (no explicit min row) when current is the lower", () => {
    expect(decidePriceBadge(90, null, 120)).toBe("best_30d");
    expect(decidePriceBadge(120, null, 120)).toBe("best_30d"); // tie → best
  });

  it("floating-point tie within epsilon still reads as best_30d", () => {
    expect(decidePriceBadge(99.999, 100, 120)).toBe("best_30d");
  });
});

describe("getPriceBadge SQL shape (in-memory)", () => {
  let db: Client;
  const NOW = 2_000_000_000;
  const cutoff = NOW - 30 * 86400;

  async function schema() {
    await db.batch([
      `CREATE TABLE products (sku TEXT PRIMARY KEY, price REAL)`,
      `CREATE TABLE price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
        old_price REAL, new_price REAL, detected_at INTEGER)`,
    ]);
  }

  beforeEach(async () => { db = createClient({ url: ":memory:" }); await schema(); });
  afterEach(() => db.close());

  it("MIN(new_price) in window + reference-before-cutoff match getPriceBadge queries", async () => {
    await db.execute({ sql: `INSERT INTO products (sku, price) VALUES (?, ?)`, args: ["SKU-A", 110] });
    // A change before the window (reference ~30d ago = 120) and a dip inside it (100).
    await db.batch([
      { sql: `INSERT INTO price_history (sku, old_price, new_price, detected_at) VALUES (?, ?, ?, ?)`, args: ["SKU-A", 140, 120, cutoff - 5 * 86400] },
      { sql: `INSERT INTO price_history (sku, old_price, new_price, detected_at) VALUES (?, ?, ?, ?)`, args: ["SKU-A", 120, 100, cutoff + 2 * 86400] },
      { sql: `INSERT INTO price_history (sku, old_price, new_price, detected_at) VALUES (?, ?, ?, ?)`, args: ["SKU-A", 100, 110, cutoff + 10 * 86400] },
    ], "write");

    const cur = (await db.execute({ sql: `SELECT MIN(price) AS p FROM products WHERE sku IN (?)`, args: ["SKU-A"] })).rows[0].p as number;
    const min30 = (await db.execute({ sql: `SELECT MIN(new_price) AS m FROM price_history WHERE sku IN (?) AND new_price IS NOT NULL AND detected_at >= ?`, args: ["SKU-A", cutoff] })).rows[0].m as number;
    const ref = (await db.execute({ sql: `SELECT new_price AS p FROM price_history WHERE sku IN (?) AND new_price IS NOT NULL AND detected_at <= ? ORDER BY detected_at DESC LIMIT 1`, args: ["SKU-A", cutoff] })).rows[0].p as number;

    expect(cur).toBe(110);
    expect(min30).toBe(100);
    expect(ref).toBe(120);
    expect(decidePriceBadge(cur, min30, ref)).toBe("price_drop");
  });

  it("reference falls back to oldest-in-window old_price when nothing precedes the cutoff", async () => {
    await db.execute({ sql: `INSERT INTO products (sku, price) VALUES (?, ?)`, args: ["SKU-B", 80] });
    // Only one change, inside the window: old_price 100 is the ~30d-ago reference.
    await db.execute({ sql: `INSERT INTO price_history (sku, old_price, new_price, detected_at) VALUES (?, ?, ?, ?)`, args: ["SKU-B", 100, 80, cutoff + 3 * 86400] });

    const before = (await db.execute({ sql: `SELECT new_price AS p FROM price_history WHERE sku IN (?) AND new_price IS NOT NULL AND detected_at <= ? ORDER BY detected_at DESC LIMIT 1`, args: ["SKU-B", cutoff] })).rows[0];
    expect(before).toBeUndefined(); // nothing before cutoff → fall back
    const fallback = (await db.execute({ sql: `SELECT old_price AS p FROM price_history WHERE sku IN (?) AND old_price IS NOT NULL AND detected_at >= ? ORDER BY detected_at ASC LIMIT 1`, args: ["SKU-B", cutoff] })).rows[0].p as number;
    const min30 = (await db.execute({ sql: `SELECT MIN(new_price) AS m FROM price_history WHERE sku IN (?) AND new_price IS NOT NULL AND detected_at >= ?`, args: ["SKU-B", cutoff] })).rows[0].m as number;

    expect(fallback).toBe(100);
    expect(min30).toBe(80);
    expect(decidePriceBadge(80, min30, fallback)).toBe("best_30d");
  });
});
