/**
 * Manual-order lookup + import tracking for Costway, against the REAL schema in an in-memory
 * libsql DB: an internal SKU from a Shopify order resolves to what must be ordered at costway.ca,
 * and the catalogue / summary expose which products are imported, in which batch, at what price.
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
let assignInternalSkus: typeof import("@/lib/costway/identity").assignInternalSkus;
let lookupVariant: typeof import("@/lib/costway/db").lookupVariant;
let getImportSummary: typeof import("@/lib/costway/db").getImportSummary;
let getCostwayCatalog: typeof import("@/lib/costway/db").getCostwayCatalog;

const feed = csv(
  { "Item No": "111", "Variant SKU": "111_BK", Title: "Déshumidificateur", "Option1 Value": "Black", "Variant Price": "100", "Canadian inventory": "7", "US Inventory": "0" },
  { "Item No": "111", "Variant SKU": "111_WH", Title: "Déshumidificateur", "Option1 Value": "White", "Variant Price": "110", "Canadian inventory": "0", "US Inventory": "4" },
  { "Item No": "222", "Variant SKU": "222_GY", Title: "Parasol", "Option1 Value": "Grey", "Variant Price": "50", Tag: "Drop Price" },
);

beforeAll(async () => {
  const database = await import("@/lib/database");
  db = await database.ensureSchema();
  ({ runCostwaySync } = await import("@/lib/costway/sync"));
  ({ assignInternalSkus } = await import("@/lib/costway/identity"));
  ({ lookupVariant, getImportSummary, getCostwayCatalog } = await import("@/lib/costway/db"));
});

/** Seed the feed, then mark item 111 as imported (draft, batch pilot-1) the way the importer does. */
async function seedImported(): Promise<Map<string, string>> {
  await runCostwaySync({ text: feed });
  const skus = await assignInternalSkus(["111_BK", "111_WH"]);
  await db.execute(
    `UPDATE costway_products SET shopify_product_id = '9001', shopify_handle = 'deshumidificateur-test', import_batch = 'pilot-1',
            import_status = 'draft', imported_at = 1760000000 WHERE item_no = '111'`,
  );
  await db.execute(`UPDATE costway_products SET sell_price = 100 WHERE sku = '111_BK'`);
  await db.execute(`UPDATE costway_products SET sell_price = 110 WHERE sku = '111_WH'`);
  return skus;
}

beforeEach(async () => {
  await db.execute(`DELETE FROM costway_products`);
  await db.execute(`DELETE FROM settings WHERE key = 'costway_last_sync'`);
});

describe("lookupVariant", () => {
  it("resolves an internal SKU to the supplier SKU, link, cost, margin and Canadian stock", async () => {
    const skus = await seedImported();
    const internal = skus.get("111_BK")!;

    const hits = await lookupVariant(internal);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      internal_sku: internal,
      supplier_sku: "111_BK",
      item_no: "111",
      color: "Black",
      feed_price: 100,
      cost: 84, // 100 less the 16% dropship discount
      sell_price: 100,
      margin_dollars: 16,
      margin_pct: 16,
      in_stock: true,
      ca_qty: 7,
      us_qty: 0,
      imported: true,
      shopify_handle: "deshumidificateur-test",
      import_status: "draft",
      import_batch: "pilot-1",
    });
    expect(hits[0].product_url).toContain("costway.ca");
  });

  it("is case-insensitive and trims an internal SKU pasted from an order", async () => {
    const skus = await seedImported();
    const internal = skus.get("111_WH")!;
    const hits = await lookupVariant(`  ${internal.toLowerCase()} `);
    expect(hits.map((h) => h.supplier_sku)).toEqual(["111_WH"]);
    expect(hits[0].ca_qty).toBe(0);
    expect(hits[0].us_qty).toBe(4);
  });

  it("also resolves a supplier SKU and an item number (all variants of the item)", async () => {
    await seedImported();
    expect((await lookupVariant("222_GY")).map((h) => h.supplier_sku)).toEqual(["222_GY"]);
    expect((await lookupVariant("111")).map((h) => h.supplier_sku)).toEqual(["111_BK", "111_WH"]);
  });

  it("reports a variant that is not imported yet, without a price or margin", async () => {
    await seedImported();
    const [h] = await lookupVariant("222_GY");
    expect(h).toMatchObject({ imported: false, internal_sku: null, sell_price: null, margin_pct: null, import_status: null });
    expect(h.cost).toBe(42);
  });

  it("returns [] for an unknown or empty query, and never matches on a partial SKU", async () => {
    await seedImported();
    expect(await lookupVariant("M0000000")).toEqual([]);
    expect(await lookupVariant("")).toEqual([]);
    expect(await lookupVariant("   ")).toEqual([]);
    expect(await lookupVariant("111_B")).toEqual([]);
  });

  it("flags a variant that left the feed", async () => {
    await seedImported();
    await db.execute(`UPDATE costway_products SET removed_at = 1760000500, in_stock = 0 WHERE sku = '111_BK'`);
    const [h] = await lookupVariant("111_BK");
    expect(h.removed).toBe(true);
    expect(h.in_stock).toBe(false);
  });
});

describe("getImportSummary", () => {
  it("is empty before anything is imported", async () => {
    await runCostwaySync({ text: feed });
    expect(await getImportSummary()).toEqual({
      importedProducts: 0,
      importedVariants: 0,
      byStatus: [],
      byBatch: [],
      estimatedMarginPerSale: 0,
    });
  });

  it("counts imported products/variants by status and batch, and sizes the margin", async () => {
    await seedImported();
    const s = await getImportSummary();
    expect(s.importedProducts).toBe(1);
    expect(s.importedVariants).toBe(2);
    expect(s.byStatus).toEqual([{ status: "draft", products: 1, variants: 2 }]);
    expect(s.byBatch).toEqual([{ batch: "pilot-1", products: 1, variants: 2, importedAt: 1760000000 }]);
    // 111_BK: 100 - 84 = 16; 111_WH: sold at 110, cost 110*0.84 = 92.4 -> 17.6
    expect(s.estimatedMarginPerSale).toBeCloseTo(33.6, 2);
  });
});

describe("getCostwayCatalog — imported / batch filters", () => {
  it("returns the import-tracking fields on an imported product", async () => {
    await seedImported();
    const { products, total } = await getCostwayCatalog({ imported: "only", page: 1, limit: 50 });
    expect(total).toBe(1);
    expect(products[0]).toMatchObject({
      item_no: "111",
      imported: true,
      shopify_product_id: "9001",
      import_status: "draft",
      import_batch: "pilot-1",
      sell_price: 105, // average of 100 and 110
    });
    expect(products[0].margin_pct).toBeCloseTo(16, 1);
    expect(products[0].margin_dollars).toBeGreaterThan(0);
  });

  it("'exclude' keeps only products that are not imported; 'all' keeps both", async () => {
    await seedImported();
    const ex = await getCostwayCatalog({ imported: "exclude", page: 1, limit: 50 });
    expect(ex.products.map((p) => p.item_no)).toEqual(["222"]);
    expect(ex.products[0]).toMatchObject({ imported: false, sell_price: null, margin_pct: null });
    const all = await getCostwayCatalog({ imported: "all", page: 1, limit: 50 });
    expect(all.total).toBe(2);
    const none = await getCostwayCatalog({ page: 1, limit: 50 });
    expect(none.total).toBe(2);
  });

  it("filters by batch label", async () => {
    await seedImported();
    expect((await getCostwayCatalog({ batch: "pilot-1", page: 1, limit: 50 })).total).toBe(1);
    expect((await getCostwayCatalog({ batch: "pilot-9", page: 1, limit: 50 })).total).toBe(0);
  });
});
