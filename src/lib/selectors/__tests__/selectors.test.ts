import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { bestSellers } from "@/lib/selectors/best-sellers";
import { priceDrops } from "@/lib/selectors/price-drops";
import { lowStock } from "@/lib/selectors/low-stock";
import { seasonal } from "@/lib/selectors/seasonal";
import { __setSelectorDbForTests } from "@/lib/selectors/db";
import { clearSelectorCache } from "@/lib/selectors/cache";
import { __setImageResolverForTests, clearImageCache } from "@/lib/selectors/shopify-images";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

/** Fresh in-memory catalog with the columns the selectors query. */
async function seedDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.batch([
    `CREATE TABLE products (
      sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER, product_type TEXT,
      shopify_product_id TEXT, shopify_handle TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
      old_price REAL, new_price REAL, old_qty INTEGER, new_qty INTEGER,
      change_type TEXT, detected_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
  ]);
  return db;
}

const now = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => now - d * 86400;

beforeEach(() => {
  clearSelectorCache();
  clearImageCache();
  // Deterministic, network-free Shopify-CDN images keyed by product id.
  __setImageResolverForTests(async (id) => [`${CDN}/${id}-1.jpg`, `${CDN}/${id}-2.jpg`]);
});

afterEach(() => {
  __setSelectorDbForTests(null);
  __setImageResolverForTests(null);
  vi.restoreAllMocks();
});

describe("bestSellers", () => {
  it("returns imported products ordered by velocity DESC with velocity14d populated", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('A','Prod A',99,10,'Patio','sp-A','prod-a')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('B','Prod B',49,10,'Patio','sp-B','prod-b')`, args: [] },
      // velocity = SUM(old_qty - new_qty) for stock decreases within the window.
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('A',50,30,'stock_change',?)`, args: [daysAgo(3)] },
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('A',30,20,'stock_change',?)`, args: [daysAgo(2)] },
      { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('B',100,90,'stock_change',?)`, args: [daysAgo(2)] },
    ], "write");
    __setSelectorDbForTests(db);

    const result = await bestSellers({ limit: 5 });
    expect(result.map((r) => r.sku)).toEqual(["A", "B"]);
    expect(result[0].velocity14d).toBe(30);
    expect(result[1].velocity14d).toBe(10);
    db.close();
  });
});

describe("priceDrops", () => {
  it("keeps only rabais >= minPct (10%) using the derived compare-at", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('DEEP','Deep',80,5,'Patio','sp-DEEP','deep')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('SHALLOW','Shallow',100,5,'Patio','sp-SHAL','shallow')`, args: [] },
      // DEEP: old_price 100 vs price 80 → 25% (kept). SHALLOW: old 105 vs 100 → 5% (dropped).
      { sql: `INSERT INTO price_history (sku, old_price, new_price, change_type, detected_at) VALUES ('DEEP',100,80,'price_drop',?)`, args: [daysAgo(1)] },
      { sql: `INSERT INTO price_history (sku, old_price, new_price, change_type, detected_at) VALUES ('SHALLOW',105,100,'price_drop',?)`, args: [daysAgo(1)] },
    ], "write");
    __setSelectorDbForTests(db);

    const result = await priceDrops({ minPct: 10 });
    expect(result.map((r) => r.sku)).toEqual(["DEEP"]);
    expect(result[0].compare_at_price).toBe(100);
    expect(result[0].discount_pct).toBe(20); // (100-80)/100
    db.close();
  });
});

describe("lowStock", () => {
  it("returns only products with qty > 0 AND qty <= threshold, scarcest first", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('OUT','Out',10,0,'Patio','sp-OUT','out')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('LOW','Low',10,2,'Patio','sp-LOW','low')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('MID','Mid',10,4,'Patio','sp-MID','mid')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('HIGH','High',10,50,'Patio','sp-HI','high')`, args: [] },
    ], "write");
    __setSelectorDbForTests(db);

    const result = await lowStock({ threshold: 5 });
    expect(result.map((r) => r.sku)).toEqual(["LOW", "MID"]); // OUT (0) and HIGH (50) excluded
    db.close();
  });
});

describe("cache (5 min)", () => {
  it("does not re-query the DB on an identical second call", async () => {
    const db = await seedDb();
    await db.execute(`INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('A','Prod A',99,3,'Patio','sp-A','prod-a')`);
    __setSelectorDbForTests(db);
    const spy = vi.spyOn(db, "execute");

    await lowStock({ threshold: 5 });
    const afterFirst = spy.mock.calls.length;
    await lowStock({ threshold: 5 });
    expect(spy.mock.calls.length).toBe(afterFirst); // served from cache
    db.close();
  });
});

describe("seasonal", () => {
  it("maps 'ete' to outdoor categories and dedupes by SKU", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('P','Patio set',199,5,'Patio','sp-P','patio')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('G','Garden bed',59,5,'Garden','sp-G','garden')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('O','Office chair',129,5,'Office Furniture','sp-O','office')`, args: [] },
    ], "write");
    __setSelectorDbForTests(db);

    const result = await seasonal("ete", { limit: 10 });
    const skus = result.map((r) => r.sku).sort();
    expect(skus).toEqual(["G", "P"]); // outdoor only; office excluded
    db.close();
  });
});

describe("image host guarantee", () => {
  it("every returned image is a cdn.shopify.com URL", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('A','Prod A',99,3,'Patio','sp-A','prod-a')`, args: [] },
      { sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle) VALUES ('B','Prod B',49,3,'Patio','sp-B','prod-b')`, args: [] },
    ], "write");
    __setSelectorDbForTests(db);

    const result = await lowStock({ threshold: 5 });
    const allImages = result.flatMap((r) => r.images);
    expect(allImages.length).toBeGreaterThan(0);
    for (const url of allImages) {
      expect(url.startsWith("https://cdn.shopify.com/")).toBe(true);
    }
    db.close();
  });
});
