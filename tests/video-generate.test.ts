import { describe, it, expect, afterEach } from "vitest";
import {
  parseGenerateRequest,
  selectProductImage,
  toSlideshowProducts,
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

  it("rejects non-ffmpeg engines (those use /api/videos)", () => {
    const r = parseGenerateRequest({ engine: "kling", productSkus: ["A"], locale: "fr" });
    expect(r.ok).toBe(false);
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
  it("maps rows to {name, price, imageUrl} with numeric price", () => {
    const out = toSlideshowProducts([
      { sku: "A", name: "Sofa", price: 499.99, image1: "https://x/a.jpg" },
      { sku: "B", name: "Lamp", price: "39.5", image2: "https://x/b.jpg" },
    ]);
    expect(out).toEqual([
      { name: "Sofa", price: 499.99, imageUrl: "https://x/a.jpg" },
      { name: "Lamp", price: 39.5, imageUrl: "https://x/b.jpg" },
    ]);
  });

  it("falls back to sku then 'Produit' for name, 0 for bad price, '' for no image", () => {
    expect(toSlideshowProducts([{ sku: "SKU1", price: "abc" }])).toEqual([
      { name: "SKU1", price: 0, imageUrl: "" },
    ]);
    expect(toSlideshowProducts([{}])).toEqual([{ name: "Produit", price: 0, imageUrl: "" }]);
  });

  it("caps the result at MAX_VIDEO_PRODUCTS", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ sku: `S${i}`, name: `N${i}`, price: i }));
    expect(toSlideshowProducts(rows)).toHaveLength(MAX_VIDEO_PRODUCTS);
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
