import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProductItem } from "@/lib/selectors/types";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

function product(overrides: Partial<ProductItem> = {}): ProductItem {
  return {
    sku: "SKU",
    title_fr: "Chaise de jardin",
    title_en: "Garden chair",
    price: 100,
    images: [`${CDN}/p.jpg`],
    product_type: "Patio",
    shopify_handle: "chaise",
    shopify_product_id: "100",
    ...overrides,
  };
}

/** Five best-sellers, best-first; #2 (index 1) carries a discount. */
function fiveBestSellers(): ProductItem[] {
  return [
    product({ sku: "A", title_fr: "Salon de jardin", price: 499 }),
    product({ sku: "B", title_fr: "Parasol déporté", price: 120, compare_at_price: 160, discount_pct: 25 }),
    product({ sku: "C", title_fr: "Chaise pliante", price: 60 }),
    product({ sku: "D", title_fr: "Table basse", price: 90 }),
    product({ sku: "E", title_fr: "Banc de jardin", price: 75 }),
  ];
}

describe("buildCountdown (dry run, mocked best-sellers)", () => {
  beforeEach(() => vi.resetModules());

  it("returns a manifest without rendering or needing a Blob token", async () => {
    vi.doMock("@/lib/selectors", () => ({ bestSellers: vi.fn(async () => fiveBestSellers()) }));
    const { buildCountdown } = await import("@/lib/slideshow/templates/countdown");

    const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN; // dry run must not require it
    try {
      const result = await buildCountdown({ brand: "ameublo", language: "fr", dryRun: true });
      expect(result.blobUrl).toBeUndefined();
      expect(result.manifest?.dryRun).toBe(true);
      expect(result.manifest?.template).toBe("COUNTDOWN");
      expect(result.manifest?.ratio).toBe("9:16");
      expect(result.manifest?.items).toHaveLength(5);
      expect(result.durationSec).toBe(13); // 390 frames / 30 fps
      expect(result.manifest?.wouldUploadTo).toMatch(/^slideshows\/ameublo\/countdown\/9x16\/\d+\.mp4$/);
      // The discounted product surfaces its badge in the manifest.
      const discounted = result.manifest?.items.find((i) => i.sku === "B");
      expect(discounted?.showsBadge).toBe(true);
      expect(discounted?.discountPct).toBe(25);
    } finally {
      if (prevToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    }
  });

  it("throws when fewer than 5 best-sellers have a Shopify image", async () => {
    vi.doMock("@/lib/selectors", () => ({
      bestSellers: vi.fn(async () => [
        product({ sku: "A" }),
        product({ sku: "B", images: [] }),
        product({ sku: "C", images: ["https://img-us.aosomcdn.com/x.jpg"] }),
      ]),
    }));
    const { buildCountdown } = await import("@/lib/slideshow/templates/countdown");
    await expect(buildCountdown({ brand: "ameublo", language: "fr", dryRun: true })).rejects.toThrow(
      /need 5 best-sellers with Shopify-CDN images, got 1/,
    );
  });
});
