import { describe, it, expect, vi, beforeEach } from "vitest";

// checkGalleryDrift(): Shopify-API-only (no Claude calls) pass that catches a product whose
// gallery changed AFTER image_checked_at was stamped — the gap image_checked_at's own reset
// (products.image1 only) never notices. See image-compliance-drift.ts.

vi.mock("@/lib/config", () => ({ env: { hasShopifyToken: true } }));

const fetchProductImages = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ fetchProductImages }));

const getCheckedProductsForDriftScan = vi.fn();
const resetImageChecked = vi.fn();
vi.mock("@/lib/database", () => ({ getCheckedProductsForDriftScan, resetImageChecked }));

const { checkGalleryDrift } = await import("@/lib/image-compliance-drift");

type Img = { id: number; position: number; src: string };
const images = (...list: Img[]) => list;

beforeEach(() => {
  fetchProductImages.mockReset();
  getCheckedProductsForDriftScan.mockReset().mockResolvedValue([]);
  resetImageChecked.mockReset().mockResolvedValue(undefined);
});

describe("checkGalleryDrift", () => {
  it("no-ops when there are no checked products to scan", async () => {
    const res = await checkGalleryDrift();
    expect(res).toEqual({ scanned: 0, drifted: 0, errors: 0 });
    expect(fetchProductImages).not.toHaveBeenCalled();
    expect(resetImageChecked).not.toHaveBeenCalled();
  });

  it("does NOT reset when the live pos-1 stem still matches the stored signature", async () => {
    getCheckedProductsForDriftScan.mockResolvedValue([{ shopifyProductId: "111", sku: "A-BK", signature: "clean" }]);
    fetchProductImages.mockResolvedValue(images({ id: 2, position: 1, src: "https://cdn.shopify.com/clean.jpg" }));

    const res = await checkGalleryDrift();

    expect(res).toEqual({ scanned: 1, drifted: 0, errors: 0 });
    expect(resetImageChecked).not.toHaveBeenCalled();
  });

  it("resets image_checked_at when the live pos-1 stem no longer matches", async () => {
    getCheckedProductsForDriftScan.mockResolvedValue([{ shopifyProductId: "111", sku: "A-BK", signature: "clean" }]);
    // Shopify re-ingested pos-1 under a different photo since the product was last checked.
    fetchProductImages.mockResolvedValue(images({ id: 9, position: 1, src: "https://cdn.shopify.com/new-overlay.jpg" }));

    const res = await checkGalleryDrift();

    expect(res).toEqual({ scanned: 1, drifted: 1, errors: 0 });
    expect(resetImageChecked).toHaveBeenCalledWith(["111"]);
  });

  it("treats a product that lost its whole gallery (no images) as drifted, not clean", async () => {
    getCheckedProductsForDriftScan.mockResolvedValue([{ shopifyProductId: "111", sku: "A-BK", signature: "clean" }]);
    fetchProductImages.mockResolvedValue(images());

    const res = await checkGalleryDrift();

    expect(res.drifted).toBe(1);
    expect(resetImageChecked).toHaveBeenCalledWith(["111"]);
  });

  it("a NULL stored signature (checked pre-migration) is NOT treated as drift unless the live gallery genuinely differs from empty", async () => {
    getCheckedProductsForDriftScan.mockResolvedValue([{ shopifyProductId: "111", sku: "A-BK", signature: null }]);
    fetchProductImages.mockResolvedValue(images());

    const res = await checkGalleryDrift();

    // "" (no stored signature) === "" (no live images) — genuinely unchanged.
    expect(res.drifted).toBe(0);
  });

  it("is non-fatal: a Shopify fetch failure is counted as an error and does not throw, other products still processed", async () => {
    getCheckedProductsForDriftScan.mockResolvedValue([
      { shopifyProductId: "111", sku: "A-BK", signature: "clean" },
      { shopifyProductId: "222", sku: "B-BK", signature: "clean" },
    ]);
    fetchProductImages
      .mockRejectedValueOnce(new Error("Shopify 500"))
      .mockResolvedValueOnce(images({ id: 1, position: 1, src: "clean.jpg" }));

    const res = await checkGalleryDrift();

    expect(res).toEqual({ scanned: 2, drifted: 0, errors: 1 });
    expect(resetImageChecked).not.toHaveBeenCalled();
  });

  it("resets multiple drifted products in one call", async () => {
    getCheckedProductsForDriftScan.mockResolvedValue([
      { shopifyProductId: "111", sku: "A-BK", signature: "clean" },
      { shopifyProductId: "222", sku: "B-BK", signature: "clean" },
      { shopifyProductId: "333", sku: "C-BK", signature: "clean" },
    ]);
    fetchProductImages
      .mockResolvedValueOnce(images({ id: 1, position: 1, src: "different.jpg" })) // drifted
      .mockResolvedValueOnce(images({ id: 2, position: 1, src: "clean.jpg" })) // unchanged
      .mockResolvedValueOnce(images({ id: 3, position: 1, src: "also-different.jpg" })); // drifted

    const res = await checkGalleryDrift();

    expect(res).toEqual({ scanned: 3, drifted: 2, errors: 0 });
    expect(resetImageChecked).toHaveBeenCalledWith(["111", "333"]);
  });

  it("respects a custom limit, passed straight to the candidate query", async () => {
    await checkGalleryDrift({ limit: 42 });
    expect(getCheckedProductsForDriftScan).toHaveBeenCalledWith(42);
  });

  it("is a complete no-op when the limit is 0", async () => {
    const res = await checkGalleryDrift({ limit: 0 });
    expect(res).toEqual({ scanned: 0, drifted: 0, errors: 0 });
    expect(getCheckedProductsForDriftScan).not.toHaveBeenCalled();
  });

  // Last: swaps env.hasShopifyToken to false via a fresh module registry, so it must not
  // run before any other test in this file (vi.resetModules would otherwise poison them).
  it("skips entirely without a Shopify token", async () => {
    vi.doMock("@/lib/config", () => ({ env: { hasShopifyToken: false } }));
    vi.resetModules();
    const { checkGalleryDrift: fresh } = await import("@/lib/image-compliance-drift");
    const res = await fresh();
    expect(res).toEqual({ scanned: 0, drifted: 0, errors: 0 });
    expect(getCheckedProductsForDriftScan).not.toHaveBeenCalled();
  });
});
