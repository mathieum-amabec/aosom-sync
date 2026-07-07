import { describe, it, expect, afterEach } from "vitest";
import {
  parseGenerateRequest,
  selectProductImage,
  selectProductImages,
  toSlideshowProducts,
  toKlingProduct,
  resolveVideoOutputPath,
  videoServeUrl,
  MAX_VIDEO_PRODUCTS,
} from "@/lib/video-engines/video-generate";

// ─── parseGenerateRequest ─────────────────────────────────────────────

describe("parseGenerateRequest", () => {
  it("accepts a valid ffmpeg request and trims SKUs", () => {
    const r = parseGenerateRequest({ engine: "ffmpeg", productSkus: [" A1 ", "B2"], locale: "fr" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.productSkus).toEqual(["A1", "B2"]);
      expect(r.value.locale).toBe("fr");
      expect(r.value.engine).toBe("ffmpeg");
    }
  });

  it("accepts the kling engine (also rendered via /api/videos/generate)", () => {
    const r = parseGenerateRequest({ engine: "kling", productSkus: ["A"], locale: "en" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.engine).toBe("kling");
  });

  it("rejects engines that aren't rendered inline (e.g. creatomate)", () => {
    expect(parseGenerateRequest({ engine: "creatomate", productSkus: ["A"], locale: "fr" }).ok).toBe(false);
    expect(parseGenerateRequest({ engine: "nope", productSkus: ["A"], locale: "fr" }).ok).toBe(false);
  });

  it("rejects empty / non-array / non-string SKUs", () => {
    expect(parseGenerateRequest({ engine: "ffmpeg", productSkus: [], locale: "fr" }).ok).toBe(false);
    expect(parseGenerateRequest({ engine: "ffmpeg", productSkus: "A", locale: "fr" }).ok).toBe(false);
    expect(parseGenerateRequest({ engine: "ffmpeg", productSkus: [1, 2], locale: "fr" }).ok).toBe(false);
    expect(parseGenerateRequest({ engine: "ffmpeg", productSkus: ["  "], locale: "fr" }).ok).toBe(false);
  });

  it("rejects more than the product cap", () => {
    const skus = Array.from({ length: MAX_VIDEO_PRODUCTS + 1 }, (_, i) => `S${i}`);
    const r = parseGenerateRequest({ engine: "ffmpeg", productSkus: skus, locale: "fr" });
    expect(r.ok).toBe(false);
  });

  it("rejects bad locales and non-object bodies", () => {
    expect(parseGenerateRequest({ engine: "ffmpeg", productSkus: ["A"], locale: "de" }).ok).toBe(false);
    expect(parseGenerateRequest(null).ok).toBe(false);
    expect(parseGenerateRequest("nope").ok).toBe(false);
  });
});

// ─── selectProductImage ───────────────────────────────────────────────

describe("selectProductImage", () => {
  it("returns the first non-empty image, skipping blanks", () => {
    expect(selectProductImage({ image1: "", image2: "  ", image3: "https://x/c.jpg" })).toBe(
      "https://x/c.jpg",
    );
    expect(selectProductImage({ image1: " https://x/a.jpg " })).toBe("https://x/a.jpg");
  });

  it("returns null when no images are present", () => {
    expect(selectProductImage({ name: "x" })).toBeNull();
    expect(selectProductImage({ image1: "", image2: "" })).toBeNull();
  });
});

// ─── toSlideshowProducts ──────────────────────────────────────────────

describe("toSlideshowProducts", () => {
  const CDN = "https://cdn.shopify.com/s/files";
  // Stub the injected Shopify image resolver (keyed by shopify_product_id).
  const IMAGES: Record<string, string[]> = {
    "sp-A": [`${CDN}/a.jpg`],
    "sp-B": [`${CDN}/b.jpg`],
    // A non-Shopify URL must be rejected by the find(isShopifyCdnUrl) filter.
    "sp-aosom": ["https://img-us.aosomcdn.com/x.jpg"],
  };
  const resolver = async (id: string): Promise<string[]> => IMAGES[id] ?? [];

  it("uses the product's Shopify-CDN image (not the Aosom image1..7 columns)", async () => {
    const out = await toSlideshowProducts(
      [
        { sku: "A", name: "Sofa", price: 499.99, shopify_product_id: "sp-A", image1: "https://img-us.aosomcdn.com/a.jpg" },
        { sku: "B", name: "Lamp", price: "39.5", shopify_product_id: "sp-B" },
      ],
      resolver,
    );
    expect(out).toEqual([
      { name: "Sofa", price: 499.99, imageUrl: `${CDN}/a.jpg` },
      { name: "Lamp", price: 39.5, imageUrl: `${CDN}/b.jpg` },
    ]);
  });

  it("imageUrl='' when the resolver returns no Shopify-CDN image (navy fallback)", async () => {
    // Missing id, unknown id, and a non-cdn.shopify.com URL all yield "".
    expect(await toSlideshowProducts([{ sku: "SKU1", price: "abc" }], resolver)).toEqual([
      { name: "SKU1", price: 0, imageUrl: "" },
    ]);
    expect(await toSlideshowProducts([{ shopify_product_id: "sp-aosom", name: "X", price: 1 }], resolver)).toEqual([
      { name: "X", price: 1, imageUrl: "" },
    ]);
    expect(await toSlideshowProducts([{}], resolver)).toEqual([{ name: "Produit", price: 0, imageUrl: "" }]);
  });

  it("caps the result at MAX_VIDEO_PRODUCTS", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ sku: `S${i}`, name: `N${i}`, price: i }));
    expect(await toSlideshowProducts(rows, resolver)).toHaveLength(MAX_VIDEO_PRODUCTS);
  });
});

// ─── selectProductImages + toKlingProduct ────────────────────────────

describe("selectProductImages", () => {
  it("collects all non-empty images in position order, trimming blanks", () => {
    expect(
      selectProductImages({ image1: " https://x/a.jpg ", image2: "", image3: "https://x/c.jpg" }),
    ).toEqual(["https://x/a.jpg", "https://x/c.jpg"]);
  });

  it("returns [] when no images are present", () => {
    expect(selectProductImages({ name: "x" })).toEqual([]);
  });
});

describe("toKlingProduct", () => {
  it("maps a row to {name, images, sku}", () => {
    expect(toKlingProduct({ sku: "A1", name: "Sofa", image1: "https://x/a.jpg", image2: "https://x/b.jpg" })).toEqual({
      name: "Sofa",
      images: ["https://x/a.jpg", "https://x/b.jpg"],
      sku: "A1",
    });
  });

  it("falls back to sku then 'Produit' for name and tolerates no images", () => {
    expect(toKlingProduct({ sku: "SKU1" })).toEqual({ name: "SKU1", images: [], sku: "SKU1" });
    expect(toKlingProduct({})).toEqual({ name: "Produit", images: [], sku: undefined });
  });
});

// ─── path / url helpers ───────────────────────────────────────────────

describe("output path + serve url", () => {
  const original = process.env.VERCEL;
  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = original;
  });

  it("writes under /tmp/videos on Vercel", () => {
    process.env.VERCEL = "1";
    expect(resolveVideoOutputPath(7).replace(/\\/g, "/")).toContain("/tmp/videos/video-7.mp4");
  });

  it("writes under public/social-videos locally", () => {
    delete process.env.VERCEL;
    expect(resolveVideoOutputPath(7).replace(/\\/g, "/")).toContain("public/social-videos/video-7.mp4");
  });

  it("serve url points at the public video-serve route", () => {
    expect(videoServeUrl(42)).toBe("/api/video-serve/42");
  });
});
