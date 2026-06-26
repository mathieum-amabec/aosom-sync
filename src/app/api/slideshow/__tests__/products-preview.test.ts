import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Mock auth + the database module. products-preview drives the REAL selectors
// (against an injected :memory: DB), so we only stub auth and the bits of
// @/lib/database the routes import directly (ensureSchema is unused — selectors
// use the injected client; getImportedProductTypes is the categories source).
const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getSessionRole: vi.fn() }));
const dbmod = vi.hoisted(() => ({ ensureSchema: vi.fn(), getImportedProductTypes: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/database", () => dbmod);

import { GET as productsPreviewGET } from "@/app/api/slideshow/products-preview/route";
import { GET as categoriesGET } from "@/app/api/products/categories/route";
import { __setSelectorDbForTests } from "@/lib/selectors/db";
import { clearSelectorCache } from "@/lib/selectors/cache";
import { __setImageResolverForTests, clearImageCache } from "@/lib/selectors/shopify-images";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";
const now = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => now - d * 86400;

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

function url(qs: string): Request {
  return new Request(`https://app.test/api/slideshow/products-preview?${qs}`);
}

beforeEach(() => {
  clearSelectorCache();
  clearImageCache();
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  __setImageResolverForTests(async (id) => [`${CDN}/${id}-1.jpg`]);
});

afterEach(() => {
  __setSelectorDbForTests(null);
  __setImageResolverForTests(null);
  vi.clearAllMocks();
});

describe("GET /api/slideshow/products-preview", () => {
  it("returns 401 without auth", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await productsPreviewGET(url("mode=best_sellers"));
    expect(res.status).toBe(401);
  });

  it("rejects an unknown mode", async () => {
    const res = await productsPreviewGET(url("mode=bogus"));
    expect(res.status).toBe(400);
  });

  it("mode=best_sellers returns an array of ProductItem", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku,name,price,qty,product_type,shopify_product_id,shopify_handle) VALUES ('A','Prod A',99,10,'Patio','sp-A','a')`, args: [] },
      { sql: `INSERT INTO price_history (sku,old_qty,new_qty,change_type,detected_at) VALUES ('A',50,30,'stock_change',?)`, args: [daysAgo(2)] },
    ], "write");
    __setSelectorDbForTests(db);

    const res = await productsPreviewGET(url("mode=best_sellers&limit=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("best_sellers");
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.count).toBe(body.products.length);
    expect(body.products[0].sku).toBe("A");
    db.close();
  });

  it("mode=price_drops returns only items with discount_pct >= 10", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku,name,price,qty,product_type,shopify_product_id,shopify_handle) VALUES ('DEEP','Deep',80,5,'Patio','sp-DEEP','deep')`, args: [] },
      { sql: `INSERT INTO products (sku,name,price,qty,product_type,shopify_product_id,shopify_handle) VALUES ('SHAL','Shallow',100,5,'Patio','sp-SHAL','shal')`, args: [] },
      { sql: `INSERT INTO price_history (sku,old_price,new_price,change_type,detected_at) VALUES ('DEEP',100,80,'price_drop',?)`, args: [daysAgo(1)] },
      { sql: `INSERT INTO price_history (sku,old_price,new_price,change_type,detected_at) VALUES ('SHAL',105,100,'price_drop',?)`, args: [daysAgo(1)] },
    ], "write");
    __setSelectorDbForTests(db);

    const res = await productsPreviewGET(url("mode=price_drops"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products.length).toBeGreaterThan(0);
    for (const p of body.products) {
      expect(p.discount_pct).toBeGreaterThanOrEqual(10);
    }
    expect(body.products.map((p: { sku: string }) => p.sku)).toEqual(["DEEP"]);
    db.close();
  });

  it("mode=by_category filters by product_type", async () => {
    const db = await seedDb();
    await db.batch([
      { sql: `INSERT INTO products (sku,name,price,qty,product_type,shopify_product_id,shopify_handle) VALUES ('P','Patio',199,5,'Patio','sp-P','p')`, args: [] },
      { sql: `INSERT INTO products (sku,name,price,qty,product_type,shopify_product_id,shopify_handle) VALUES ('O','Office',129,5,'Office Furniture','sp-O','o')`, args: [] },
    ], "write");
    __setSelectorDbForTests(db);

    const res = await productsPreviewGET(url("mode=by_category&category=Patio"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products.map((p: { sku: string }) => p.sku)).toEqual(["P"]);
    db.close();
  });

  it("mode=by_category without a category is a 400", async () => {
    const res = await productsPreviewGET(url("mode=by_category"));
    expect(res.status).toBe(400);
  });

  it("every returned image is a cdn.shopify.com URL", async () => {
    const db = await seedDb();
    await db.execute(`INSERT INTO products (sku,name,price,qty,product_type,shopify_product_id,shopify_handle) VALUES ('A','Prod A',99,3,'Patio','sp-A','a')`);
    __setSelectorDbForTests(db);

    const res = await productsPreviewGET(url("mode=best_sellers"));
    const body = await res.json();
    // best_sellers needs velocity rows; seed had none, so fall back to a direct mode:
    const res2 = await productsPreviewGET(url("mode=manual&skus=A"));
    const body2 = await res2.json();
    const images = [...body.products, ...body2.products].flatMap((p: { images: string[] }) => p.images);
    for (const u of images) expect(u.startsWith("https://cdn.shopify.com/")).toBe(true);
    db.close();
  });
});

describe("GET /api/products/categories", () => {
  it("returns 401 without auth", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await categoriesGET();
    expect(res.status).toBe(401);
  });

  it("returns an array of non-empty category strings", async () => {
    dbmod.getImportedProductTypes.mockResolvedValue(["Office Furniture", "Patio"]);
    const res = await categoriesGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.categories.length).toBeGreaterThan(0);
    for (const c of body.categories) {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
    }
  });
});
