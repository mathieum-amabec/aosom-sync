import { describe, it, expect } from "vitest";
import {
  renderSlideshow,
  buildManifest,
  ratioDimensions,
  estimateDurationSec,
  blobPath,
  buildXfadeFilterComplex,
} from "@/lib/slideshow/render";
import { validateSlideshowConfig, shouldShowBadge } from "@/lib/slideshow/validate";
import {
  SlideshowTemplate,
  type SlideshowConfig,
  type SlideshowItem,
} from "@/lib/slideshow/types";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

function item(overrides: Partial<SlideshowItem> = {}): SlideshowItem {
  return {
    image_url: `${CDN}/product.jpg`,
    overlay_text: "Chaise de jardin",
    price: 100,
    ...overrides,
  };
}

function config(overrides: Partial<SlideshowConfig> = {}): SlideshowConfig {
  return {
    items: [item()],
    template: SlideshowTemplate.SHOWCASE,
    ratio: "9:16",
    brand: "ameublo",
    language: "fr",
    ...overrides,
  };
}

describe("renderSlideshow (dry run)", () => {
  it("returns a manifest and uploads nothing", async () => {
    const result = await renderSlideshow(config({ dryRun: true, title: "Soldes" }));
    expect(result.blobUrl).toBeUndefined();
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.dryRun).toBe(true);
    expect(result.manifest?.items).toHaveLength(1);
    expect(result.durationSec).toBeGreaterThan(0);
    // The dry-run target is the canonical Blob path, but nothing was written.
    expect(result.manifest?.wouldUploadTo).toMatch(
      /^slideshows\/ameublo\/showcase\/9x16\/\d+\.mp4$/,
    );
  });

  it("throws (does not silently upload) on an invalid config", async () => {
    await expect(
      renderSlideshow(config({ dryRun: true, items: [item({ image_url: "https://img-us.aosomcdn.com/x.jpg" })] })),
    ).rejects.toThrow(/cdn\.shopify\.com/);
  });
});

describe("validateSlideshowConfig", () => {
  it("rejects non-cdn.shopify.com image URLs", () => {
    const v = validateSlideshowConfig(config({ items: [item({ image_url: "https://img-us.aosomcdn.com/x.jpg" })] }));
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("cdn.shopify.com");
  });

  it("accepts a clean cdn.shopify.com config", () => {
    expect(validateSlideshowConfig(config()).valid).toBe(true);
  });

  it("rejects an empty item list", () => {
    expect(validateSlideshowConfig(config({ items: [] })).valid).toBe(false);
  });

  it("rejects more than 20 items", () => {
    const items = Array.from({ length: 21 }, () => item());
    const v = validateSlideshowConfig(config({ items }));
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/at most 20/);
  });

  it("rejects an invalid ratio and brand", () => {
    const v = validateSlideshowConfig(
      config({ ratio: "4:3" as unknown as SlideshowConfig["ratio"], brand: "acme" as unknown as SlideshowConfig["brand"] }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/ratio/);
    expect(v.errors.join(" ")).toMatch(/brand/);
  });
});

describe("discount badge rule (compare_at >= price * 1.10)", () => {
  it("shows the badge at exactly 10% and above", () => {
    expect(shouldShowBadge(100, 110)).toBe(true);
    expect(shouldShowBadge(100, 150)).toBe(true);
  });

  it("hides the badge below 10% or with no compare_at", () => {
    expect(shouldShowBadge(100, 109)).toBe(false);
    expect(shouldShowBadge(100, undefined)).toBe(false);
    expect(shouldShowBadge(100, 100)).toBe(false);
  });

  it("reflects the rule in the manifest with the discount percentage", () => {
    const manifest = buildManifest(
      config({
        items: [item({ price: 100, compare_at: 130 }), item({ price: 100, compare_at: 105 })],
      }),
      1_700_000_000_000,
    );
    expect(manifest.items[0].showsBadge).toBe(true);
    expect(manifest.items[0].discountPct).toBe(23); // (130-100)/130 ≈ 23%
    expect(manifest.items[1].showsBadge).toBe(false);
    expect(manifest.items[1].discountPct).toBeUndefined();
  });
});

describe("overlay text cleanup (formatVideoTitle per slide)", () => {
  it("strips ellipsis and never cuts mid-word in the manifest overlay", () => {
    const dirty = "Climatiseur portatif 10 000 BTU pour grande pièce résidentielle moderne…";
    const manifest = buildManifest(config({ items: [item({ overlay_text: dirty })] }), 1);
    const cleaned = manifest.items[0].overlay_text;
    expect(cleaned).not.toContain("…");
    expect(cleaned.length).toBeLessThanOrEqual(48);
    // No trailing partial word: the cleaned text is a prefix of the original words.
    expect(dirty.startsWith(cleaned.split(" ").slice(0, 2).join(" "))).toBe(true);
  });
});

describe("pure render helpers", () => {
  it("maps ratios to pixel dimensions", () => {
    expect(ratioDimensions("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(ratioDimensions("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(ratioDimensions("16:9")).toEqual({ width: 1920, height: 1080 });
  });

  it("estimates duration with crossfade overlaps", () => {
    // intro(2) + 2 slides(3.5) + outro(2) = 11, minus 3 xfades * 0.5 = 9.5
    expect(estimateDurationSec(2)).toBe(9.5);
  });

  it("builds the canonical Blob path", () => {
    expect(blobPath("furnish", "PRICE_DROP", "16:9", 42)).toBe(
      "slideshows/furnish/price_drop/16x9/42.mp4",
    );
  });

  it("chains xfades and fades the music in/out", () => {
    const { filterComplex, videoLabel, audioLabel } = buildXfadeFilterComplex({
      count: 3,
      durations: [2, 3.5, 2],
      dims: { width: 1080, height: 1920 },
      hasMusic: true,
      musicVolumeDb: -18,
      totalSec: 6.5,
    });
    expect(videoLabel).toBe("vout");
    expect(audioLabel).toBe("aout");
    expect(filterComplex).toContain("xfade=transition=fade");
    expect(filterComplex).toContain("afade=t=in:st=0:d=1");
    expect(filterComplex).toContain("afade=t=out:st=4.5:d=2");
  });
});
