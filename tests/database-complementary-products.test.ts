/**
 * getComplementaryProducts — feeds the storefront assistant's cross-sell tool
 * (recommend_complementary_products, src/lib/assistant.ts). Both guardrails (never
 * out of stock, never a product with a known unresolved image issue) are enforced in
 * this function's SQL, so they are tested here against the REAL schema in an
 * in-memory libsql database, not against a copy of the SQL.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let getComplementaryProducts: typeof import("@/lib/database").getComplementaryProducts;

beforeAll(async () => {
  const mod = await import("@/lib/database");
  db = await mod.ensureSchema();
  getComplementaryProducts = mod.getComplementaryProducts;
});

beforeEach(async () => {
  await db.execute(`DELETE FROM products`);
  await db.execute(`DELETE FROM image_review_queue`);
});

async function product(over: {
  sku: string;
  qty?: number;
  productType?: string;
  shopifyId?: string | null;
  handle?: string | null;
  imageChecked?: boolean;
}) {
  await db.execute({
    sql: `INSERT INTO products
            (sku, name, price, qty, product_type, color, image1,
             shopify_product_id, shopify_handle, image_checked_at)
          VALUES (?, ?, 99, ?, ?, 'Gris', 'https://img/x.jpg', ?, ?, ?)`,
    args: [
      over.sku,
      `Produit ${over.sku}`,
      over.qty ?? 5,
      over.productType ?? "Home Furnishings > Living Room > Coffee Tables",
      over.shopifyId === undefined ? "900" : over.shopifyId,
      over.handle === undefined ? `${over.sku.toLowerCase()}-handle` : over.handle,
      over.imageChecked === false ? null : Math.floor(Date.now() / 1000),
    ],
  });
}

async function reviewRow(sku: string, status: string) {
  await db.execute({
    sql: `INSERT INTO image_review_queue
            (shopify_product_id, sku, current_url, proposed_url, status)
          VALUES ('900', ?, 'https://img/bad.jpg', 'https://img/good.jpg', ?)`,
    args: [sku, status],
  });
}

describe("getComplementaryProducts — cross-sell guardrails (SQL-level)", () => {
  it("includes a clean, in-stock, verified product", async () => {
    await product({ sku: "RUG-1", productType: "Home Furnishings > Home Décor > Area Rugs" });

    const rows = await getComplementaryProducts({ excludeSku: "BASE-1" });

    expect(rows.map((r) => r.sku)).toEqual(["RUG-1"]);
  });

  it("excludes a product with qty = 0 — never recommend out of stock", async () => {
    await product({ sku: "OOS-1", qty: 0 });

    expect(await getComplementaryProducts({ excludeSku: "BASE-1" })).toEqual([]);
  });

  it("excludes a product with an unresolved image_review_queue row (pending)", async () => {
    await product({ sku: "BAD-IMG-1" });
    await reviewRow("BAD-IMG-1", "pending");

    expect(await getComplementaryProducts({ excludeSku: "BASE-1" })).toEqual([]);
  });

  it("excludes a product whose flagged image fix failed", async () => {
    await product({ sku: "BAD-IMG-2" });
    await reviewRow("BAD-IMG-2", "failed");

    expect(await getComplementaryProducts({ excludeSku: "BASE-1" })).toEqual([]);
  });

  it("includes a product whose flagged image issue was already applied (fixed)", async () => {
    await product({ sku: "FIXED-1" });
    await reviewRow("FIXED-1", "applied");

    const rows = await getComplementaryProducts({ excludeSku: "BASE-1" });

    expect(rows.map((r) => r.sku)).toEqual(["FIXED-1"]);
  });

  it("excludes a product never checked for image compliance (image_checked_at IS NULL)", async () => {
    await product({ sku: "UNCHECKED-1", imageChecked: false });

    expect(await getComplementaryProducts({ excludeSku: "BASE-1" })).toEqual([]);
  });

  it("excludes the base product itself", async () => {
    await product({ sku: "BASE-1" });
    await product({ sku: "OTHER-1" });

    const rows = await getComplementaryProducts({ excludeSku: "BASE-1" });

    expect(rows.map((r) => r.sku)).toEqual(["OTHER-1"]);
  });

  it("excludes a product not imported to Shopify (no shopify_product_id)", async () => {
    await product({ sku: "NOT-IMPORTED", shopifyId: null });

    expect(await getComplementaryProducts({ excludeSku: "BASE-1" })).toEqual([]);
  });

  it("excludes a product with no storefront handle", async () => {
    await product({ sku: "NO-HANDLE", handle: null });

    expect(await getComplementaryProducts({ excludeSku: "BASE-1" })).toEqual([]);
  });

  it("filters by productType when provided", async () => {
    await product({ sku: "RUG-1", productType: "Home Furnishings > Home Décor > Area Rugs" });
    await product({ sku: "LAMP-1", productType: "Home Furnishings > Home Décor > Floor Lamps & Ceiling Fan Lights" });

    const rows = await getComplementaryProducts({ excludeSku: "BASE-1", productType: "Area Rugs" });

    expect(rows.map((r) => r.sku)).toEqual(["RUG-1"]);
  });
});
