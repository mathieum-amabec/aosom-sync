import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderCarousel,
  buildCarouselManifest,
  buildCarouselOverlaySvg,
  carouselDimensions,
  carouselBlobPath,
} from "@/lib/slideshow/carousel/render";
import type { CarouselConfig } from "@/lib/slideshow/carousel/types";
import type { SlideshowItem } from "@/lib/slideshow/types";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

function item(overrides: Partial<SlideshowItem> = {}): SlideshowItem {
  return { image_url: `${CDN}/product.jpg`, overlay_text: "Chaise de jardin", price: 100, ...overrides };
}

function config(overrides: Partial<CarouselConfig> = {}): CarouselConfig {
  return { items: [item()], brand: "ameublo", language: "fr", format: "1080x1080", ...overrides };
}

describe("renderCarousel (dry run)", () => {
  it("returns a manifest and writes nothing (no Sharp, no Blob)", async () => {
    const result = await renderCarousel(config({ dryRun: true, items: [item(), item({ sku: "X2" })] }));
    expect(result.blobUrls).toBeUndefined();
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.dryRun).toBe(true);
    expect(result.manifest?.count).toBe(2);
    expect(result.manifest?.items).toHaveLength(2);
    expect(result.manifest?.wouldUploadTo).toMatch(/^slideshows\/ameublo\/carousel\/1080x1080\/\d+\/$/);
  });

  it("targets the canonical Blob prefix for the brand + format", async () => {
    const result = await renderCarousel(config({ dryRun: true, format: "1080x1350", brand: "furnish" }));
    expect(result.manifest?.wouldUploadTo).toMatch(/^slideshows\/furnish\/carousel\/1080x1350\/\d+\/$/);
  });

  it("throws on a non-cdn.shopify.com image (never silently uploads)", async () => {
    await expect(
      renderCarousel(config({ dryRun: true, items: [item({ image_url: "https://img-us.aosomcdn.com/x.jpg" })] })),
    ).rejects.toThrow(/cdn\.shopify\.com/);
  });

  it("throws on an empty item list", async () => {
    await expect(renderCarousel(config({ dryRun: true, items: [] }))).rejects.toThrow(/at least one item/);
  });
});

describe("carousel manifest — discount badge rule (compare_at >= price * 1.10)", () => {
  it("flags the badge and discount percentage per item", () => {
    const manifest = buildCarouselManifest(
      config({ items: [item({ price: 100, compare_at: 130 }), item({ price: 100, compare_at: 105 })] }),
      1_700_000_000_000,
    );
    expect(manifest.items[0].showsBadge).toBe(true);
    expect(manifest.items[0].discountPct).toBe(23); // (130-100)/130 ≈ 23%
    expect(manifest.items[1].showsBadge).toBe(false);
    expect(manifest.items[1].discountPct).toBeUndefined();
  });

  it("cleans the overlay text (no ellipsis, no mid-word cut)", () => {
    const dirty = "Climatiseur portatif 10 000 BTU pour grande pièce résidentielle ultra moderne…";
    const manifest = buildCarouselManifest(config({ items: [item({ overlay_text: dirty })] }), 1);
    expect(manifest.items[0].overlay_text).not.toContain("…");
    expect(manifest.items[0].overlay_text.length).toBeLessThanOrEqual(40);
  });
});

describe("buildCarouselOverlaySvg", () => {
  it("draws the title and price", () => {
    const svg = buildCarouselOverlaySvg(item({ overlay_text: "Table de jardin", price: 249.99 }), { width: 1080, height: 1080 }, "fr");
    expect(svg).toContain("Table de jardin");
    expect(svg).toContain("249.99 $");
    expect(svg).not.toMatch(/-\d+%/); // no discount badge without compare_at
  });

  it("adds a struck-through compare-at and a -N% badge when discounted", () => {
    const svg = buildCarouselOverlaySvg(item({ price: 100, compare_at: 130 }), { width: 1080, height: 1080 }, "fr");
    expect(svg).toContain("line-through");
    expect(svg).toContain("-23%");
  });
});

describe("pure carousel helpers", () => {
  it("maps formats to pixel dimensions", () => {
    expect(carouselDimensions("1080x1080")).toEqual({ width: 1080, height: 1080 });
    expect(carouselDimensions("1080x1350")).toEqual({ width: 1080, height: 1350 });
  });

  it("builds the numbered Blob path per card", () => {
    expect(carouselBlobPath("furnish", "1080x1350", 42, 3)).toBe("slideshows/furnish/carousel/1080x1350/42/3.png");
  });
});

describe("carousel templates (dry run, mocked selectors)", () => {
  beforeEach(() => vi.resetModules());

  it("builds a best-sellers carousel and drops products without a Shopify image", async () => {
    vi.doMock("@/lib/selectors", () => ({
      bestSellers: vi.fn(async () => [
        { sku: "A", title_fr: "Chaise", title_en: "Chair", price: 100, images: [`${CDN}/a.jpg`], product_type: "", shopify_handle: "", shopify_product_id: "1" },
        { sku: "B", title_fr: "Table", title_en: "Table", price: 200, compare_at_price: 260, images: [`${CDN}/b.jpg`], product_type: "", shopify_handle: "", shopify_product_id: "2" },
        { sku: "C", title_fr: "Banc", title_en: "Bench", price: 50, images: [], product_type: "", shopify_handle: "", shopify_product_id: "3" }, // no image → dropped
      ]),
      priceDrops: vi.fn(),
      lowStock: vi.fn(),
    }));
    const { buildBestSellersCarousel } = await import("@/lib/slideshow/carousel/templates");
    const result = await buildBestSellersCarousel({ brand: "ameublo", language: "fr", dryRun: true });
    expect(result.manifest?.count).toBe(2);
    expect(result.manifest?.items.map((i) => i.sku)).toEqual(["A", "B"]);
    expect(result.manifest?.items[1].showsBadge).toBe(true);
  });

  it("throws when no selected product has a usable image", async () => {
    vi.doMock("@/lib/selectors", () => ({
      bestSellers: vi.fn(),
      priceDrops: vi.fn(async () => [
        { sku: "Z", title_fr: "X", title_en: "X", price: 9, images: ["https://img-us.aosomcdn.com/z.jpg"], product_type: "", shopify_handle: "", shopify_product_id: "9" },
      ]),
      lowStock: vi.fn(),
    }));
    const { buildPriceDropCarousel } = await import("@/lib/slideshow/carousel/templates");
    await expect(buildPriceDropCarousel({ brand: "furnish", language: "en", dryRun: true })).rejects.toThrow(/no products with Shopify-CDN images/);
  });
});
