import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShopifyExistingProduct } from "@/types/sync";
import {
  computePriceDiffs,
  applyPriceDiffs,
  writeReport,
  type PriceDiff,
} from "../scripts/force-push-shopify";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdateVariantPrice = vi.hoisted(() => vi.fn());
const mockUpdateProduct = vi.hoisted(() => vi.fn());
const mockFetchVariant = vi.hoisted(() => vi.fn());

vi.mock("@/lib/shopify-client", () => ({
  fetchAllShopifyProducts: vi.fn(),
  updateShopifyVariantPrice: mockUpdateVariantPrice,
  // LAYER 1: applyPriceDiffs now writes through writePriceVerified, which reads the
  // variant back to confirm the price actually stuck before counting it as applied.
  fetchVariant: mockFetchVariant,
  // Intentionally exposed — Test 3 asserts it is NEVER called.
  updateShopifyProduct: mockUpdateProduct,
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDbProduct(overrides: Partial<{
  sku: string; shopify_product_id: string; price: number; qty: number; name: string;
}> = {}) {
  return {
    sku: "84G-720V00GY",
    shopify_product_id: "7750488948841",
    price: 214.99,
    qty: 5,
    name: "Test Furniture",
    ...overrides,
  };
}

function makeShopifyProduct(overrides: Partial<ShopifyExistingProduct> & {
  variantSku?: string; variantPrice?: number; variantId?: string;
} = {}): ShopifyExistingProduct {
  const {
    variantSku = "84G-720V00GY",
    variantPrice = 179.99,
    variantId = "variant-001",
    ...rest
  } = overrides;
  return {
    shopifyId: "7750488948841",
    title: "Test Furniture",
    status: "active",
    bodyHtml: "<p>Some description</p>",
    productType: "Furniture",
    images: ["https://cdn.example.com/img.jpg"],
    tags: [],
    variants: [
      {
        variantId,
        sku: variantSku,
        price: variantPrice,
        inventoryQuantity: 0,
        inventoryItemId: "inv-001",
        option1: null,
        option2: null,
        weight: 10,
        gtin: "",
      },
    ],
    ...rest,
  };
}

function makeShopifyMap(product: ShopifyExistingProduct): Map<string, ShopifyExistingProduct> {
  return new Map([[product.shopifyId, product]]);
}

function makePriceDiff(overrides: Partial<PriceDiff> = {}): PriceDiff {
  return {
    type: "price",
    sku: "84G-720V00GY",
    shopify_product_id: "7750488948841",
    variant_id: "variant-001",
    db_price: 214.99,
    shopify_price: 179.99,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

const noSleep = async () => {};

describe("force-push-shopify", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default read-back matches the standard fixture's db_price (214.99) so a write
    // confirms on the first attempt unless a test overrides it.
    mockFetchVariant.mockResolvedValue({ price: 214.99 });
  });

  // ── Test 1 ────────────────────────────────────────────────────────────────
  it("dry-run: identifies price diffs without calling any Shopify write API", () => {
    // DB price $214.99, Shopify price $179.99 → 1 diff expected
    const db = [makeDbProduct({ price: 214.99 })];
    const shopifyMap = makeShopifyMap(makeShopifyProduct({ variantPrice: 179.99 }));

    const diffs = computePriceDiffs(db, shopifyMap);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      type: "price",
      sku: "84G-720V00GY",
      db_price: 214.99,
      shopify_price: 179.99,
      variant_id: "variant-001",
    });

    // computePriceDiffs is pure — no write API involved.
    expect(mockUpdateVariantPrice).not.toHaveBeenCalled();
    expect(mockUpdateProduct).not.toHaveBeenCalled();
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it("apply mode: calls updateShopifyVariantPrice with correct variant_id and db_price", async () => {
    mockUpdateVariantPrice.mockResolvedValue(undefined);

    const diff = makePriceDiff({ variant_id: "variant-001", db_price: 214.99 });
    const result = await applyPriceDiffs([diff], { delayMs: 0 });

    expect(mockUpdateVariantPrice).toHaveBeenCalledOnce();
    expect(mockUpdateVariantPrice).toHaveBeenCalledWith("variant-001", 214.99);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it("never pushes description or body_html (architectural boundary)", async () => {
    mockUpdateVariantPrice.mockResolvedValue(undefined);

    // Shopify has completely different body_html from DB description — ignored by design.
    const db = [makeDbProduct({ price: 214.99 })];
    const shopifyProduct = makeShopifyProduct({
      variantPrice: 179.99,
      bodyHtml: "<p>Totally different description that nobody should overwrite</p>",
    });
    const shopifyMap = makeShopifyMap(shopifyProduct);

    const diffs = computePriceDiffs(db, shopifyMap);

    // Only price diffs ever produced — no description type.
    const badDiffs = diffs.filter((d) => d.type !== "price" && d.type !== "missing_product" && d.type !== "missing_variant");
    expect(badDiffs).toHaveLength(0);

    // In apply mode: only updateShopifyVariantPrice is called — never updateShopifyProduct.
    const priceDiffs = diffs.filter((d): d is PriceDiff => d.type === "price");
    await applyPriceDiffs(priceDiffs, { delayMs: 0 });

    expect(mockUpdateVariantPrice).toHaveBeenCalled();
    expect(mockUpdateProduct).not.toHaveBeenCalled();
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  it("handles missing variant match by SKU gracefully (warn + skip, no throw)", () => {
    const db = [makeDbProduct({ sku: "SKU-NOT-IN-SHOPIFY" })];
    // Shopify product exists, but its variant has a different SKU.
    const shopifyProduct = makeShopifyProduct({
      variantSku: "SOME-OTHER-SKU",
    });
    const shopifyMap = makeShopifyMap(shopifyProduct);

    // Must not throw.
    expect(() => computePriceDiffs(db, shopifyMap)).not.toThrow();

    const diffs = computePriceDiffs(db, shopifyMap);

    // One warning entry, no price diff.
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("missing_variant");
    expect(diffs[0].sku).toBe("SKU-NOT-IN-SHOPIFY");

    // Naturally: no write calls since no price diffs exist.
    expect(mockUpdateVariantPrice).not.toHaveBeenCalled();
  });

  // ── Test 5 ────────────────────────────────────────────────────────────────
  it("respects rate limiting: setTimeout called with >= 100ms between writes", async () => {
    mockUpdateVariantPrice.mockResolvedValue(undefined);

    // Spy on setTimeout, capture delay arg, but resolve immediately (no real wait).
    const capturedDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, delay?: number) => {
      if (typeof delay === "number") capturedDelays.push(delay);
      return realSetTimeout(fn, 0);
    });

    const diffs: PriceDiff[] = [
      makePriceDiff({ sku: "SKU-A", variant_id: "v-a" }),
      makePriceDiff({ sku: "SKU-B", variant_id: "v-b" }),
    ];

    // Use default delayMs (APPLY_DELAY_MS = 100).
    await applyPriceDiffs(diffs);

    // One setTimeout call per diff (2 total), each with exactly 100ms.
    expect(capturedDelays.length).toBeGreaterThanOrEqual(2);
    expect(capturedDelays.every((d) => d >= 100)).toBe(true);

    setTimeoutSpy.mockRestore();
  });

  // ── Test 6 ────────────────────────────────────────────────────────────────
  it("prices-already-match: returns empty diffs (idempotency guarantee)", () => {
    // DB price === Shopify price → no diff expected.
    const db = [makeDbProduct({ price: 214.99 })];
    const shopifyMap = makeShopifyMap(makeShopifyProduct({ variantPrice: 214.99 }));

    const diffs = computePriceDiffs(db, shopifyMap);

    expect(diffs).toHaveLength(0);
    expect(mockUpdateVariantPrice).not.toHaveBeenCalled();
  });

  // ── Test 7 ────────────────────────────────────────────────────────────────
  it("missing product on Shopify: returns missing_product entry (warn + skip)", () => {
    const db = [makeDbProduct({ shopify_product_id: "DOES-NOT-EXIST" })];
    // Empty map — product not on Shopify.
    const shopifyMap = new Map<string, ReturnType<typeof makeShopifyProduct>>();

    const diffs = computePriceDiffs(db, shopifyMap);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("missing_product");
    expect(diffs[0].sku).toBe("84G-720V00GY");
    expect(mockUpdateVariantPrice).not.toHaveBeenCalled();
  });

  // ── Test 8 ────────────────────────────────────────────────────────────────
  it("apply mode: error path — records failure after exhausting retries, continues", async () => {
    // Persistent (not "Once"): writePriceVerified retries up to 3x, so a single
    // rejection would now succeed on attempt 2. Reject every attempt to prove the
    // failure path still fires once retries are genuinely exhausted.
    mockUpdateVariantPrice.mockRejectedValue(new Error("429 Too Many Requests"));

    const diff = makePriceDiff({ sku: "FAIL-SKU", variant_id: "v-fail" });
    const result = await applyPriceDiffs([diff], { delayMs: 0, sleep: noSleep });

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].sku).toBe("FAIL-SKU");
    expect(result.errors[0].error).toContain("429 Too Many Requests");
    expect(mockUpdateVariantPrice).toHaveBeenCalledTimes(3); // all 3 attempts spent
  });

  // ── Test 8b ───────────────────────────────────────────────────────────────
  it("apply mode: a write that fails once then succeeds on retry counts as applied", async () => {
    // The behavior test 8 used to (incorrectly) assert: one transient failure is no
    // longer a hard failure — LAYER 1 retries and this is exactly the case it exists
    // to recover from.
    mockUpdateVariantPrice
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce(undefined);

    const diff = makePriceDiff({ sku: "RETRY-OK", variant_id: "v-retry" });
    const result = await applyPriceDiffs([diff], { delayMs: 0, sleep: noSleep });

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockUpdateVariantPrice).toHaveBeenCalledTimes(2);
  });

  // ── Test 9 ────────────────────────────────────────────────────────────────
  it("partial failure: first succeeds, second fails, both counts correct", async () => {
    mockUpdateVariantPrice
      .mockResolvedValueOnce(undefined) // SKU-OK's single write
      .mockRejectedValue(new Error("Shopify timeout")); // SKU-FAIL: every attempt

    const diffs: PriceDiff[] = [
      makePriceDiff({ sku: "SKU-OK",   variant_id: "v-ok" }),
      makePriceDiff({ sku: "SKU-FAIL", variant_id: "v-fail" }),
    ];
    const result = await applyPriceDiffs(diffs, { delayMs: 0, sleep: noSleep });

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0].sku).toBe("SKU-FAIL");
  });

  // ── Test 10 ────────────────────────────────────────────────────────────────
  it("non-Error throw: string error serialized via String(err) into errors array", async () => {
    // Coverage for the `String(err)` branch when a non-Error value is rejected.
    mockUpdateVariantPrice.mockRejectedValue("network gone"); // every attempt

    const diff = makePriceDiff({ sku: "STRING-ERR", variant_id: "v-str" });
    const result = await applyPriceDiffs([diff], { delayMs: 0, sleep: noSleep });

    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe("network gone");
  });

  // ── Test 11 ───────────────────────────────────────────────────────────────
  it("LAYER 1 regression: a write Shopify accepts (200) but never persists is NOT counted as applied", async () => {
    // Reproduces the exact shape of the 842-375V00CG incident: the PUT resolves, but a
    // read-back shows the old price is still live. Before this fix, applyPriceDiffs
    // trusted the PUT alone and would have counted this as "applied".
    mockUpdateVariantPrice.mockResolvedValue(undefined); // every attempt "succeeds"
    mockFetchVariant.mockResolvedValue({ price: 179.99 }); // but Shopify never actually moved

    const diff = makePriceDiff({ sku: "GHOST-WRITE", variant_id: "v-ghost", db_price: 214.99 });
    const result = await applyPriceDiffs([diff], { delayMs: 0, sleep: noSleep });

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].sku).toBe("GHOST-WRITE");
    expect(result.errors[0].error).toContain("read-back mismatch");
  });

  // ── Test 11 ────────────────────────────────────────────────────────────────
  it("PRICE_TOLERANCE boundary: small diff (< 0.01) produces no diff, large diff (> 0.01) does", () => {
    // 0.005 difference — clearly within tolerance, no diff expected.
    const withinTolerance = [makeDbProduct({ price: 100.005 })];
    const shopifyWithin = makeShopifyMap(makeShopifyProduct({ variantPrice: 100.00 }));
    expect(computePriceDiffs(withinTolerance, shopifyWithin)).toHaveLength(0);

    // 0.02 difference — clearly over tolerance, diff expected.
    const overTolerance = [makeDbProduct({ price: 100.02 })];
    const shopifyOver = makeShopifyMap(makeShopifyProduct({ variantPrice: 100.00 }));
    expect(computePriceDiffs(overTolerance, shopifyOver)).toHaveLength(1);
  });
});

// ─── writeReport ──────────────────────────────────────────────────────────────
describe("writeReport", () => {
  it("writes a timestamped JSON file to scripts/reports/", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");

    writeReport({
      mode: "dry-run",
      diffs: [],
      applied: 0,
      failed: 0,
      errors: [],
    });

    expect(mkdirSync).toHaveBeenCalledOnce();
    expect(writeFileSync).toHaveBeenCalledOnce();

    const [filePath, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(filePath).toMatch(/force-push-\d{4}-\d{2}-\d{2}.*\.json$/);
    const parsed = JSON.parse(content);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.timestamp).toBeDefined();
  });
});
