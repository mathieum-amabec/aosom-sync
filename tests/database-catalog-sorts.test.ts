/**
 * getProducts — every catalog "Sort by" option must run against the REAL query.
 *
 * The "Nouveaux produits Aosom" sort 500'd in production (`ambiguous column name: sku`):
 * its ORDER BY used a bare `sku` while the final SELECT LEFT JOINs `last_price`, which
 * also has a `sku`. The older mirror test in database.test.ts copied the SQL without the
 * join, so it passed. These tests call getProducts itself on the real schema.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let getProducts: typeof import("@/lib/database").getProducts;

// Every <option value> of the catalog page's sort select (src/app/(dashboard)/catalog/page.tsx).
const SORTS = ["", "best_sellers", "price_drop", "price_asc", "price_desc", "qty_asc", "qty_desc", "low_stock", "newest"];

beforeAll(async () => {
  const mod = await import("@/lib/database");
  db = await mod.ensureSchema();
  getProducts = mod.getProducts;
});

beforeEach(async () => {
  // price_history references products (FK) — delete children first.
  await db.execute(`DELETE FROM price_history`);
  await db.execute(`DELETE FROM products`);
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  for (const [sku, age] of [["SKU-OLD", 30], ["SKU-NEW", 0], ["SKU-MID", 5]] as const) {
    await db.execute({
      sql: `INSERT INTO products (sku, name, price, qty, created_at) VALUES (?, ?, 100, 5, ?)`,
      args: [sku, `Produit ${sku}`, now - age * day],
    });
  }
  // A price change on SKU-MID so the last_price LEFT JOIN actually matches a row.
  await db.execute({
    sql: `INSERT INTO price_history (sku, old_price, new_price, change_type, detected_at) VALUES ('SKU-MID', 120, 100, 'price_drop', ?)`,
    args: [now - day],
  });
});

describe("getProducts — catalog sorts run against the real query", () => {
  it.each(SORTS)("sort=%s returns rows without a SQL error", async (sort) => {
    const r = await getProducts({ sort: sort || undefined, page: 1, limit: 50 });
    expect(r.total).toBe(3);
    expect(r.products).toHaveLength(3);
  });

  it("newest puts the most recently added product first", async () => {
    const r = await getProducts({ sort: "newest", page: 1, limit: 50 });
    expect(r.products.map((p) => p.sku)).toEqual(["SKU-NEW", "SKU-MID", "SKU-OLD"]);
  });

  it("newest still works combined with a search term", async () => {
    const r = await getProducts({ sort: "newest", search: "Produit", page: 1, limit: 50 });
    expect(r.products.map((p) => p.sku)).toEqual(["SKU-NEW", "SKU-MID", "SKU-OLD"]);
  });
});
