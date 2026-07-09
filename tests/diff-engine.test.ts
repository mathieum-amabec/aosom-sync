import { describe, it, expect } from "vitest";
import {
  computeDiffs, summarizeDiffs, stockBufferQty, applyStockTags,
  hasAutoDraftedTag, addAutoDraftedTag, removeAutoDraftedTag, STOCK_TAG_AUTODRAFTED,
} from "@/lib/diff-engine";
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
    // Baseline aosom qty 10 → buffered 7 (in stock), so the consistent tag is back-in-stock.
    tags: ["back-in-stock"],
    variants: [
      {
        variantId: "V1",
        sku: "TEST-001",
        price: 99.99,
        inventoryQuantity: 7, // = stockBufferQty(10): aosom qty 10 → 10 - 3, so the baseline has no stock diff
        inventoryItemId: "INV1",
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

  it("price floor: forces a below-Aosom Shopify price UP to the Aosom price", () => {
    // Shopify is priced below the Aosom CSV price (e.g. a manual under-price) — the
    // diff must emit a price change that raises it back to the Aosom floor.
    const aosom = makeAosom();
    aosom.variants[0].price = 85.99;
    const shopify = makeShopify();
    shopify.variants[0].price = 79.99; // below the Aosom floor
    const diffs = computeDiffs([aosom], [shopify]);
    const priceChange = diffs[0].changes.find((c) => c.field === "price")!;
    expect(priceChange.oldValue).toBe(79.99);
    expect(priceChange.newValue).toBe(85.99); // raised to the Aosom floor
    expect(Number(priceChange.newValue)).toBeGreaterThanOrEqual(85.99); // never below floor
  });

  it("never emits a price below the Aosom floor (realign-down stays at Aosom)", () => {
    // Shopify above Aosom → realign down to the Aosom price, never under it.
    const aosom = makeAosom();
    aosom.variants[0].price = 85.99;
    const shopify = makeShopify();
    shopify.variants[0].price = 120.0;
    const diffs = computeDiffs([aosom], [shopify]);
    const priceChange = diffs[0].changes.find((c) => c.field === "price")!;
    expect(priceChange.newValue).toBe(85.99);
    expect(Number(priceChange.newValue)).toBeGreaterThanOrEqual(85.99);
  });

  it("diffs stock with the safety buffer (qty > 5 → qty - 3)", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 20; // buffered → 17; Shopify baseline is 7
    const diffs = computeDiffs([aosom], [makeShopify()]);
    const stock = diffs[0].changes.find((c) => c.field === "stock")!;
    expect(stock).toBeDefined();
    expect(stock.oldValue).toBe(7);
    expect(stock.newValue).toBe(17);
  });

  it("buffers low Aosom stock to 0 (épuisé at qty <= 5)", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 4; // <= 5 → 0
    const diffs = computeDiffs([aosom], [makeShopify()]);
    const stock = diffs[0].changes.find((c) => c.field === "stock")!;
    expect(stock.newValue).toBe(0);
  });

  it("emits no stock change when the buffered qty already matches Shopify available", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 10; // buffered → 7 = baseline inventoryQuantity
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(0);
  });

  it("puts price-containing diffs ahead of image/description-only diffs", () => {
    const priced = makeAosom();
    priced.variants[0].price = 109.99; // price diff
    const descOnly = makeAosom({
      groupKey: "G-DESC",
      variants: [{ ...makeAosom().variants[0], sku: "DESC-001" }],
      description: "<p>changed</p>",
    });
    const shopifyDesc = makeShopify({
      shopifyId: "SHOP-DESC",
      variants: [{ ...makeShopify().variants[0], sku: "DESC-001" }],
    });
    // descOnly passed first, priced second — expect priced sorted to the front.
    const diffs = computeDiffs([descOnly, priced], [makeShopify(), shopifyDesc]);
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    expect(diffs[0].changes.some((c) => c.field === "price")).toBe(true);
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

describe("stockBufferQty (safety buffer: qty<=5 → 0, else qty-3)", () => {
  it("treats the threshold and below as sold out (0)", () => {
    expect(stockBufferQty(0)).toBe(0);
    expect(stockBufferQty(1)).toBe(0);
    expect(stockBufferQty(5)).toBe(0); // boundary: 5 → 0
  });

  it("shaves the margin above the threshold", () => {
    expect(stockBufferQty(6)).toBe(3); // boundary: first above → 6 - 3
    expect(stockBufferQty(8)).toBe(5);
    expect(stockBufferQty(100)).toBe(97);
  });
});

describe("applyStockTags (mutually-exclusive stock-state pair, preserves others)", () => {
  it("adds back-in-stock and removes out-of-stock when in stock", () => {
    expect(applyStockTags(["sale", "out-of-stock"], true)).toEqual(["sale", "back-in-stock"]);
  });
  it("adds out-of-stock and removes back-in-stock when out", () => {
    expect(applyStockTags(["sale", "back-in-stock"], false)).toEqual(["sale", "out-of-stock"]);
  });
  it("is case-insensitive on the pair (no duplicates)", () => {
    expect(applyStockTags(["Back-In-Stock"], false)).toEqual(["out-of-stock"]);
  });
});

describe("stock-state tag transitions (computeDiffs)", () => {
  it("flips to out-of-stock when all variants buffer to 0", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 4; // <=5 → 0 → out of stock
    const diffs = computeDiffs([aosom], [makeShopify()]); // baseline tags ["back-in-stock"]
    const tagChange = diffs[0].changes.find((c) => c.field === "tags")!;
    expect(tagChange).toBeDefined();
    expect(tagChange.newValue).toBe("out-of-stock");
  });

  it("flips to back-in-stock when a variant returns to (buffered) stock", () => {
    const aosom = makeAosom(); // qty 10 → buffered 7 → in stock
    const shopify = makeShopify({ tags: ["out-of-stock"] });
    shopify.variants[0].inventoryQuantity = 0;
    const diffs = computeDiffs([aosom], [shopify]);
    const tagChange = diffs[0].changes.find((c) => c.field === "tags")!;
    expect(tagChange.newValue).toBe("back-in-stock");
  });

  it("emits no tag change when the stock state already matches the tags", () => {
    // Baseline: in stock + tags already ["back-in-stock"] → no tag diff.
    const diffs = computeDiffs([makeAosom()], [makeShopify()]);
    expect(diffs.some((d) => d.changes.some((c) => c.field === "tags"))).toBe(false);
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

describe("auto-drafted tag helpers", () => {
  it("hasAutoDraftedTag detects the marker case-insensitively", () => {
    expect(hasAutoDraftedTag(["a", STOCK_TAG_AUTODRAFTED])).toBe(true);
    expect(hasAutoDraftedTag(["a", "Auto-Drafted"])).toBe(true);
    expect(hasAutoDraftedTag(["a", "b"])).toBe(false);
  });
  it("addAutoDraftedTag appends once, never duplicates", () => {
    expect(addAutoDraftedTag(["x"])).toEqual(["x", STOCK_TAG_AUTODRAFTED]);
    expect(addAutoDraftedTag(["x", STOCK_TAG_AUTODRAFTED])).toEqual(["x", STOCK_TAG_AUTODRAFTED]);
    expect(addAutoDraftedTag(["x", "Auto-Drafted"])).toEqual(["x", "Auto-Drafted"]); // case-insensitive no-op
  });
  it("removeAutoDraftedTag strips the marker case-insensitively, keeps the rest", () => {
    expect(removeAutoDraftedTag(["keep", STOCK_TAG_AUTODRAFTED])).toEqual(["keep"]);
    expect(removeAutoDraftedTag(["keep", "Auto-Drafted"])).toEqual(["keep"]);
    expect(removeAutoDraftedTag(["keep"])).toEqual(["keep"]);
  });
});
