/**
 * Costway sync end-to-end against the REAL schema in an in-memory libsql DB: parse → diff →
 * write → browse. Also pins the separation guarantee: the Aosom `products` table is never
 * touched by a Costway sync.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { Client } from "@libsql/client";

// Must be set before database.ts is imported: it caches its client on first use.
process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

// Real feed has ~22k rows; the absolute floor would reject a 3-row fixture.
vi.mock("@/lib/config", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/config")>();
  return { ...orig, COSTWAY: { ...orig.COSTWAY, MIN_ROWS_ABSOLUTE: 1 } };
});

import { csv } from "./fixtures/costway-csv";

let db: Client;
let runCostwaySync: typeof import("@/lib/costway/sync").runCostwaySync;
let getCostwayCatalog: typeof import("@/lib/costway/db").getCostwayCatalog;
let getCostwaySummary: typeof import("@/lib/costway/db").getCostwaySummary;

beforeAll(async () => {
  const database = await import("@/lib/database");
  db = await database.ensureSchema();
  ({ runCostwaySync } = await import("@/lib/costway/sync"));
  ({ getCostwayCatalog, getCostwaySummary } = await import("@/lib/costway/db"));
});

beforeEach(async () => {
  await db.execute(`DELETE FROM costway_products`);
  await db.execute(`DELETE FROM settings WHERE key = 'costway_last_sync'`);
  await db.execute(`DELETE FROM products`);
});

const feedV1 = csv(
  { "Item No": "111", "Variant SKU": "111_BK", Title: "Chaise", "Option1 Value": "Black", "Variant Price": "100" },
  { "Item No": "111", "Variant SKU": "111_WH", Title: "Chaise", "Option1 Value": "White", "Variant Price": "110", "1=In Stock|0=OOS": "0" },
  { "Item No": "222", "Variant SKU": "222_GY", Title: "Parasol", Category: "Outdoor > Shades", "Variant Price": "50", Tag: "Clearance" },
);

describe("runCostwaySync", () => {
  it("dry run writes nothing", async () => {
    const s = await runCostwaySync({ text: feedV1, dryRun: true });
    expect(s).toMatchObject({ dryRun: true, variants: 3, products: 2, inserted: 3 });
    const n = await db.execute(`SELECT COUNT(*) AS n FROM costway_products`);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("first sync inserts, second sync is a no-op, then stock/removal updates are applied", async () => {
    const first = await runCostwaySync({ text: feedV1 });
    expect(first).toMatchObject({ inserted: 3, contentUpdated: 0, volatileUpdated: 0, removed: 0 });

    const again = await runCostwaySync({ text: feedV1 });
    expect(again).toMatchObject({ inserted: 0, contentUpdated: 0, volatileUpdated: 0, unchanged: 3, removed: 0 });

    // 111_WH back in stock, 222_GY gone from the feed.
    const feedV2 = csv(
      { "Item No": "111", "Variant SKU": "111_BK", Title: "Chaise", "Option1 Value": "Black", "Variant Price": "100" },
      { "Item No": "111", "Variant SKU": "111_WH", Title: "Chaise", "Option1 Value": "White", "Variant Price": "110" },
    );
    const third = await runCostwaySync({ text: feedV2 });
    expect(third).toMatchObject({ volatileUpdated: 1, removed: 1 });

    const gone = await db.execute(`SELECT in_stock, removed_at FROM costway_products WHERE sku = '222_GY'`);
    expect(Number(gone.rows[0].in_stock)).toBe(0);
    expect(gone.rows[0].removed_at).not.toBeNull();
  });

  it("never touches the Aosom products table", async () => {
    await db.execute(`INSERT INTO products (sku, name, price, qty) VALUES ('84A-001', 'Aosom', 10, 3)`);
    await runCostwaySync({ text: feedV1 });
    const aosom = await db.execute(`SELECT sku, qty FROM products`);
    expect(aosom.rows.map((r) => [r.sku, Number(r.qty)])).toEqual([["84A-001", 3]]);
  });
});

describe("getCostwayCatalog / getCostwaySummary", () => {
  beforeEach(async () => {
    await runCostwaySync({ text: feedV1 });
  });

  it("groups variants per Item No", async () => {
    const { products, total } = await getCostwayCatalog({ page: 1, limit: 50 });
    expect(total).toBe(2);
    const chair = products.find((p) => p.item_no === "111")!;
    expect(chair).toMatchObject({ variants: 2, in_stock_variants: 1, min_price: 100, max_price: 110 });
    expect(chair.colors?.split(",").sort()).toEqual(["Black", "White"]);
  });

  it("filters by category, stock, promo tag, price and search", async () => {
    const q = (f: object) => getCostwayCatalog({ page: 1, limit: 50, ...f }).then((r) => r.products.map((p) => p.item_no));
    expect(await q({ topCategory: "Outdoor" })).toEqual(["222"]);
    expect(await q({ promoTag: "Clearance" })).toEqual(["222"]);
    expect(await q({ maxPrice: 60 })).toEqual(["222"]);
    expect(await q({ search: "Chaise" })).toEqual(["111"]);
    expect(await q({ search: "111_WH" })).toEqual(["111"]);
  });

  it("summarises products, stock and categories", async () => {
    const s = await getCostwaySummary();
    expect(s).toMatchObject({ products: 2, inStockProducts: 2, variants: 3, inStockVariants: 2 });
    expect(s.categories.map((c) => c.category).sort()).toEqual(["Furniture", "Outdoor"]);
    expect(s.promoTags).toEqual([{ tag: "Clearance", variants: 1 }]);
  });
});

describe("getCostwayShopifyProductIds — the id set the Aosom sweeps exclude", () => {
  it("is empty while nothing is imported, then returns only linked, non-blank ids (deduped across variants)", async () => {
    const { getCostwayShopifyProductIds } = await import("@/lib/database");
    await runCostwaySync({ text: feedV1 });
    expect((await getCostwayShopifyProductIds()).size).toBe(0);

    await db.execute(`UPDATE costway_products SET shopify_product_id = '9001' WHERE item_no = '111'`);
    await db.execute(`UPDATE costway_products SET shopify_product_id = '  ' WHERE sku = '222_GY'`);
    expect([...(await getCostwayShopifyProductIds())]).toEqual(["9001"]);
  });

  it("never reads the Aosom products table", async () => {
    const { getCostwayShopifyProductIds } = await import("@/lib/database");
    await db.execute(`INSERT INTO products (sku, name, shopify_product_id) VALUES ('AOS-1', 'x', '777')`);
    expect((await getCostwayShopifyProductIds()).has("777")).toBe(false);
  });
});
