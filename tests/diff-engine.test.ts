import { describe, it, expect } from "vitest";
import { computeDiffs, summarizeDiffs } from "@/lib/diff-engine";
import type { AosomMergedProduct } from "@/types/aosom";
import type { ShopifyExistingProduct } from "@/types/sync";

function makeAosom(overrides: Partial<AosomMergedProduct> = {}): AosomMergedProduct {
  return {
    groupKey: "GROUP1",
    name: "Test Product",
    brand: "Aosom",
    productType: "Test",
    category: "Test",
    description: "<p>Description</p>",
    shortDescription: "Short",
    material: "Metal",
    images: ["https://img.com/1.jpg"],
    video: "",
    pdf: "",
    variants: [
      {
        sku: "TEST-001",
        price: 99.99,
        qty: 10,
        color: "Noir",
        size: "",
        gtin: "",
        weight: 5,
        dimensions: { length: 10, width: 10, height: 10 },
        images: ["https://img.com/1.jpg"],
        estimatedArrival: "",
        outOfStockExpected: "",
        packageNum: "",
        boxSize: "",
        boxWeight: "",
      },
    ],
    ...overrides,
  };
}

function makeShopify(overrides: Partial<ShopifyExistingProduct> = {}): ShopifyExistingProduct {
  return {
    shopifyId: "SHOP1",
    title: "Test Product",
    status: "active",
    bodyHtml: "<p>Description</p>",
    productType: "Test",
    images: ["https://img.com/1.jpg"],
    variants: [
      {
        variantId: "V1",
        sku: "TEST-001",
        price: 99.99,
        inventoryQuantity: 10,
        option1: "Noir",
        option2: null,
        weight: 5,
        gtin: "",
      },
    ],
    ...overrides,
  };
}

describe("computeDiffs", () => {
  it("detects no changes when products match", () => {
    const diffs = computeDiffs([makeAosom()], [makeShopify()]);
    expect(diffs).toHaveLength(0);
  });

  it("detects price change", () => {
    const aosom = makeAosom();
    aosom.variants[0].price = 109.99;
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].action).toBe("update");
    expect(diffs[0].changes.some((c) => c.field === "price")).toBe(true);
    const priceChange = diffs[0].changes.find((c) => c.field === "price")!;
    expect(priceChange.oldValue).toBe(99.99);
    expect(priceChange.newValue).toBe(109.99);
  });

  it("detects stock change", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 0;
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.some((c) => c.field === "stock")).toBe(true);
  });

  it("detects image change", () => {
    const aosom = makeAosom({ images: ["https://img.com/new.jpg"] });
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.some((c) => c.field === "images")).toBe(true);
  });

  it("detects description change", () => {
    const aosom = makeAosom({ description: "<p>New description</p>" });
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.some((c) => c.field === "description")).toBe(true);
  });

  it("identifies new products not in Shopify", () => {
    const aosom = makeAosom({ groupKey: "NEW", variants: [{ ...makeAosom().variants[0], sku: "NEW-001" }] });
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs.some((d) => d.action === "create")).toBe(true);
  });

  it("identifies products removed from CSV", () => {
    const shopify = makeShopify({
      shopifyId: "ORPHAN",
      variants: [{ ...makeShopify().variants[0], sku: "ORPHAN-001" }],
    });
    const diffs = computeDiffs([], [shopify]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].action).toBe("archive");
  });

  it("does not archive already-draft products", () => {
    const shopify = makeShopify({
      status: "draft",
      variants: [{ ...makeShopify().variants[0], sku: "DRAFT-001" }],
    });
    const diffs = computeDiffs([], [shopify]);
    expect(diffs).toHaveLength(0);
  });

  it("detects new variant added to existing product", () => {
    const aosom = makeAosom();
    aosom.variants.push({
      ...aosom.variants[0],
      sku: "TEST-002",
      color: "Gris",
    });
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.some((c) => c.field === "new_variant")).toBe(true);
  });
});

describe("summarizeDiffs", () => {
  it("counts changes correctly", () => {
    const aosom1 = makeAosom();
    aosom1.variants[0].price = 109.99;
    const aosom2 = makeAosom({
      groupKey: "G2",
      variants: [{ ...makeAosom().variants[0], sku: "NEW-001" }],
    });
    const diffs = computeDiffs([aosom1, aosom2], [makeShopify()]);
    const summary = summarizeDiffs(diffs);
    expect(summary.updates).toBe(1);
    expect(summary.creates).toBe(1);
    expect(summary.priceChanges).toBe(1);
  });
});
