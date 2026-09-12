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
        qty: 20,
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
    // Baseline aosom qty 20 → buffered 17 (in stock), so the consistent tag is back-in-stock.
    tags: ["back-in-stock"],
    variants: [
      {
        variantId: "V1",
        sku: "TEST-001",
        price: 99.99,
        inventoryQuantity: 17, // = stockBufferQty(20): aosom qty 20 → 20 - 3, so the baseline has no stock diff
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

  it("diffs stock with the safety buffer (qty > 10 → qty - 3)", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 30; // buffered → 27; Shopify baseline is 17
    const diffs = computeDiffs([aosom], [makeShopify()]);
    const stock = diffs[0].changes.find((c) => c.field === "stock")!;
    expect(stock).toBeDefined();
    expect(stock.oldValue).toBe(17);
    expect(stock.newValue).toBe(27);
  });

  it("buffers low Aosom stock to 0 (épuisé at qty <= 10, the danger zone)", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 8; // <= 10 → 0 (was sellable under the old ≤5 threshold)
    const diffs = computeDiffs([aosom], [makeShopify()]);
    const stock = diffs[0].changes.find((c) => c.field === "stock")!;
    expect(stock.newValue).toBe(0);
  });

  it("emits no stock change when the buffered qty already matches Shopify available", () => {
    const aosom = makeAosom();
    aosom.variants[0].qty = 20; // buffered → 17 = baseline inventoryQuantity
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(0);
  });

  it("puts price-containing diffs ahead of image-only diffs", () => {
    const priced = makeAosom();
    priced.variants[0].price = 109.99; // price diff
    const imageOnly = makeAosom({
      groupKey: "G-IMG",
      variants: [{ ...makeAosom().variants[0], sku: "DESC-001" }],
      images: ["https://img.com/changed.jpg"],
    });
    const shopifyDesc = makeShopify({
      shopifyId: "SHOP-DESC",
      variants: [{ ...makeShopify().variants[0], sku: "DESC-001" }],
    });
    // imageOnly passed first, priced second — expect priced sorted to the front.
    const diffs = computeDiffs([imageOnly, priced], [makeShopify(), shopifyDesc]);
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    expect(diffs[0].changes.some((c) => c.field === "price")).toBe(true);
  });

  it("detects image change", () => {
    const aosom = makeAosom({ images: ["https://img.com/new.jpg"] });
    const diffs = computeDiffs([aosom], [makeShopify()]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.some((c) => c.field === "images")).toBe(true);
  });

  // ── Architectural boundary: the feed never overwrites the authored description ──
  //
  // Regression guard for the 2026-04-05 → 2026-09-11 bug (b497260): the feed
  // description is raw ENGLISH, the Shopify body_html is curated FRENCH, so a
  // description diff was true on every run and the daily push overwrote French with
  // English on ~5-7 products/day (679 of 1382 active products, 49%, ended up English).
  it("never emits a description change, even when the feed description differs", () => {
    const aosom = makeAosom({ description: "<p>New English description from the Aosom feed</p>" });
    const shopify = makeShopify({ bodyHtml: "<p>Description française rédigée à l'import</p>" });
    const diffs = computeDiffs([aosom], [shopify]);
    // A description-only delta is not a change at all → no diff is produced.
    expect(diffs).toHaveLength(0);
  });

  it("does not emit a description change alongside a real (price) change", () => {
    const aosom = makeAosom({ description: "<p>English feed copy</p>" });
    aosom.variants[0].price = 109.99;
    const shopify = makeShopify({ bodyHtml: "<p>Texte français rédigé</p>" });
    const diffs = computeDiffs([aosom], [shopify]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].changes.some((c) => c.field === "price")).toBe(true);
    expect(diffs[0].changes.some((c) => c.field === "description")).toBe(false);
  });

  it("drops the description-only product from a batch while keeping the real-change one", () => {
    // Batch shape: one product whose only delta is the description, one with a real
    // (stock) delta. Exactly one diff must come out, and it must be the real one.
    const descOnly = makeAosom({ description: "<p>English feed copy nobody asked for</p>" });
    const shopifyDescOnly = makeShopify({ bodyHtml: "<p>Le texte français rédigé à l'import</p>" });

    const realChange = makeAosom({
      groupKey: "G-REAL",
      description: "<p>Also different English copy</p>",
      variants: [{ ...makeAosom().variants[0], sku: "REAL-001", qty: 5 }],
    });
    const shopifyReal = makeShopify({
      shopifyId: "SHOP-REAL",
      bodyHtml: "<p>Texte français</p>",
      variants: [{ ...makeShopify().variants[0], sku: "REAL-001" }],
    });

    const diffs = computeDiffs([descOnly, realChange], [shopifyDescOnly, shopifyReal]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].shopifyId).toBe("SHOP-REAL");
    expect(diffs[0].changes.some((c) => c.field === "description")).toBe(false);
  });

  it("reports zero descriptionChanges in the summary whatever the feed says", () => {
    const aosom = makeAosom({ description: "<p>Completely different feed copy</p>" });
    aosom.variants[0].price = 109.99;
    const diffs = computeDiffs([aosom], [makeShopify({ bodyHtml: "<p>Le texte FR</p>" })]);
    expect(summarizeDiffs(diffs).descriptionChanges).toBe(0);
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

describe("stockBufferQty (safety buffer: qty<=10 → 0, else qty-3)", () => {
  it("treats the threshold and below as sold out (0)", () => {
    expect(stockBufferQty(0)).toBe(0);
    expect(stockBufferQty(1)).toBe(0);
    expect(stockBufferQty(5)).toBe(0);
    expect(stockBufferQty(10)).toBe(0); // boundary: 10 → 0 (danger zone)
  });

  it("shaves the margin above the threshold", () => {
    expect(stockBufferQty(11)).toBe(8); // boundary: first above → 11 - 3
    expect(stockBufferQty(13)).toBe(10);
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
    const aosom = makeAosom(); // qty 20 → buffered 17 → in stock
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
