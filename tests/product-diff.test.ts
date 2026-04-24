import { describe, it, expect } from "vitest";
import { diffProductsLight, type ProductDiffResult } from "@/lib/product-diff";
import type { AosomProduct } from "@/types/aosom";
import type { ProductSnapshot } from "@/lib/database";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProduct(overrides: Partial<AosomProduct> = {}): AosomProduct {
  return {
    sku: "SKU-001",
    name: "Test Product",
    price: 99.99,
    qty: 5,
    color: "Black",
    size: "",
    shortDescription: "",
    description: "<p>desc</p>",
    images: ["img1.jpg", "img2.jpg", "", "", "", "", ""],
    gtin: "",
    weight: 10,
    dimensions: { length: 0, width: 0, height: 0 },
    productType: "Furniture",
    category: "Furniture",
    brand: "Test",
    material: "",
    psin: "PSIN-001",
    sin: "",
    video: "",
    estimatedArrival: "",
    outOfStockExpected: "",
    packageNum: "",
    boxSize: "",
    boxWeight: "",
    pdf: "",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    sku: "SKU-001",
    name: "Test Product",
    price: 99.99,
    qty: 5,
    color: "Black",
    size: "",
    product_type: "Furniture",
    image1: "img1.jpg",
    image2: "img2.jpg",
    image3: "",
    image4: "",
    image5: "",
    image6: "",
    image7: "",
    video: "",
    description: "<p>desc</p>",
    short_description: "",
    material: "",
    gtin: "",
    weight: 10,
    out_of_stock_expected: "",
    estimated_arrival: "",
    shopify_product_id: null,
    ...overrides,
  };
}

function makeMap(...snaps: ProductSnapshot[]): Map<string, ProductSnapshot> {
  const m = new Map<string, ProductSnapshot>();
  for (const s of snaps) m.set(s.sku, s);
  return m;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("diffProductsLight", () => {
  // Test 1: new SKU not in snapshot → toInsert
  it("classifies new SKU (not in snapshot) as toInsert", () => {
    const csv = [makeProduct({ sku: "NEW-SKU" })];
    const snap = makeMap(); // empty snapshot

    const result = diffProductsLight(csv, snap);

    expect(result.toInsert).toHaveLength(1);
    expect(result.toInsert[0].sku).toBe("NEW-SKU");
    expect(result.toUpdate).toHaveLength(0);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toHaveLength(0);
  });

  // Test 2: unchanged product → unchanged count
  it("classifies product with no field changes as unchanged", () => {
    const csv = [makeProduct()];
    const snap = makeMap(makeSnapshot());

    const result = diffProductsLight(csv, snap);

    expect(result.toInsert).toHaveLength(0);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.unchanged).toBe(1);
    expect(result.removed).toHaveLength(0);
  });

  // Test 3: price change → toUpdate
  it("classifies price change as toUpdate", () => {
    const csv = [makeProduct({ price: 129.99 })];
    const snap = makeMap(makeSnapshot({ price: 99.99 }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
    expect(result.toUpdate[0].sku).toBe("SKU-001");
    expect(result.toInsert).toHaveLength(0);
    expect(result.unchanged).toBe(0);
  });

  // Test 4: qty change → toUpdate
  it("classifies qty change as toUpdate", () => {
    const csv = [makeProduct({ qty: 0 })];
    const snap = makeMap(makeSnapshot({ qty: 5 }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
    expect(result.unchanged).toBe(0);
  });

  // Test 5: image change → toUpdate
  it("classifies image1 change as toUpdate", () => {
    const csv = [makeProduct({ images: ["NEW-img.jpg", "img2.jpg", "", "", "", "", ""] })];
    const snap = makeMap(makeSnapshot({ image1: "img1.jpg" }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
  });

  // Test 6: SKU in snapshot but missing from CSV → removed
  it("classifies SKU absent from CSV as removed", () => {
    const csv: AosomProduct[] = []; // no products in feed
    const snap = makeMap(makeSnapshot({ sku: "GHOST-SKU" }));

    const result = diffProductsLight(csv, snap);

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toBe("GHOST-SKU");
    expect(result.toInsert).toHaveLength(0);
    expect(result.unchanged).toBe(0);
  });

  // Test 7: mixed batch — 1 insert, 1 update, 1 unchanged, 1 removed
  it("correctly classifies a mixed batch of 4 products", () => {
    const csv = [
      makeProduct({ sku: "NEW", price: 50 }),
      makeProduct({ sku: "CHANGED", price: 200 }),
      makeProduct({ sku: "SAME", price: 30 }),
    ];
    const snap = makeMap(
      makeSnapshot({ sku: "CHANGED", price: 100 }),
      makeSnapshot({ sku: "SAME", price: 30 }),
      makeSnapshot({ sku: "GONE", price: 10 }),
    );

    const result = diffProductsLight(csv, snap);

    expect(result.toInsert.map(p => p.sku)).toEqual(["NEW"]);
    expect(result.toUpdate.map(p => p.sku)).toEqual(["CHANGED"]);
    expect(result.unchanged).toBe(1);
    expect(result.removed).toEqual(["GONE"]);
  });

  // Test 8: out_of_stock_expected change → toUpdate
  it("classifies outOfStockExpected change as toUpdate", () => {
    const csv = [makeProduct({ outOfStockExpected: "2026-06-01" })];
    const snap = makeMap(makeSnapshot({ out_of_stock_expected: "" }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
  });

  // Test 9: estimatedArrival change → toUpdate
  it("classifies estimatedArrival change as toUpdate", () => {
    const csv = [makeProduct({ estimatedArrival: "2 weeks" })];
    const snap = makeMap(makeSnapshot({ estimated_arrival: "" }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
  });

  // Test 10: empty CSV + empty snapshot → all zeros
  it("returns all-zero result for empty inputs", () => {
    const result = diffProductsLight([], new Map());

    expect(result.toInsert).toHaveLength(0);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toHaveLength(0);
  });

  // Test 11: name change → toUpdate
  it("classifies name change as toUpdate", () => {
    const csv = [makeProduct({ name: "New Name" })];
    const snap = makeMap(makeSnapshot({ name: "Test Product" }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
    expect(result.unchanged).toBe(0);
  });

  // Test 12: color change → toUpdate
  it("classifies color change as toUpdate", () => {
    const csv = [makeProduct({ color: "White" })];
    const snap = makeMap(makeSnapshot({ color: "Black" }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
  });

  // Test 13: material change → toUpdate
  it("classifies material change as toUpdate", () => {
    const csv = [makeProduct({ material: "Steel" })];
    const snap = makeMap(makeSnapshot({ material: "" }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
  });

  // Test 14: weight change → toUpdate
  it("classifies weight change as toUpdate", () => {
    const csv = [makeProduct({ weight: 25 })];
    const snap = makeMap(makeSnapshot({ weight: 10 }));

    const result = diffProductsLight(csv, snap);

    expect(result.toUpdate).toHaveLength(1);
  });

  // Test 15: images shorter than 7 → treats missing as empty string
  it("treats missing images (short array) as empty string when comparing", () => {
    // CSV has only 2 images, snapshot has all 7 empty
    const csv = [makeProduct({ images: ["a.jpg", "b.jpg"] })];
    const snap = makeMap(makeSnapshot({
      image1: "a.jpg", image2: "b.jpg",
      image3: "", image4: "", image5: "", image6: "", image7: "",
    }));

    const result = diffProductsLight(csv, snap);

    // images[2..6] are undefined → treated as "" → matches snapshot empty strings
    expect(result.unchanged).toBe(1);
    expect(result.toUpdate).toHaveLength(0);
  });
});
