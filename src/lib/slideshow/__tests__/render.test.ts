import { describe, it, expect } from "vitest";
import {
  renderSlideshow,
  buildManifest,
  ratioDimensions,
  estimateDurationSec,
  perSlideSeconds,
  blobPath,
  buildXfadeFilterComplex,
  wrapTitle,
  wrapLines,
  buildSlideOverlaySvg,
  transitionsFor,
  xfadeSecFor,
  kenBurnsExpr,
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

  it("rejects a musicUrl that is a URL or escapes the audio roots (SSRF guard)", async () => {
    await expect(renderSlideshow(config({ dryRun: true, musicUrl: "http://169.254.169.254/x.mp3" }))).rejects.toThrow(/musicUrl/);
    await expect(renderSlideshow(config({ dryRun: true, musicUrl: "../../etc/shadow.mp3" }))).rejects.toThrow(/musicUrl/);
    // A bundled track under an allowed root is accepted.
    const ok = await renderSlideshow(config({ dryRun: true, musicUrl: "public/music/track.mp3" }));
    expect(ok.manifest?.music).toBe("public/music/track.mp3");
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

  it("rejects an unlisted template (Blob-key safety)", () => {
    const v = validateSlideshowConfig(
      config({ template: "../../etc" as unknown as SlideshowConfig["template"] }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/template/);
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

describe("wrapLines (intro hook — every line bounded, ≤ maxLines)", () => {
  it("bounds all but the last line and never loses words", () => {
    const hooks = [
      "🔥 Soldes qui font MAL au portefeuille (en bien)",
      "😮 Ces produits cachés valent VRAIMENT le détour",
      "🚨 Alerte best-seller — stocks limités !",
      "🎯 3 produits que tu DOIS voir aujourd'hui",
    ];
    for (const h of hooks) {
      const lines = wrapLines(h, 18, 3);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines.join(" ")).toBe(h); // no words dropped
      // Every line except possibly the last (which takes the remainder) is ≤18.
      lines.slice(0, -1).forEach((l) => expect(l.length).toBeLessThanOrEqual(18));
    }
  });

  it("a short hook stays on one line", () => {
    expect(wrapLines("⚡ Best-sellers", 18, 3)).toEqual(["⚡ Best-sellers"]);
  });
});

describe("title wrap + overlays (quality v2)", () => {
  it("wraps a title onto at most 2 lines on a word boundary", () => {
    expect(wrapTitle("Chaise", 16)).toEqual(["Chaise"]);
    const two = wrapTitle("Ventilateur tour oscillant silencieux", 16);
    expect(two.length).toBe(2);
    expect(two.join(" ")).toBe("Ventilateur tour oscillant silencieux"); // no words lost
    expect(two[0].length).toBeLessThanOrEqual(20);
  });

  it("a product overlay caps the title at 28 chars (no ellipsis) and shows the price", () => {
    const svg = buildSlideOverlaySvg(
      { image_url: `${CDN}/x.jpg`, overlay_text: "Climatiseur portatif 10 000 BTU pour grande pièce", price: 99 },
      { width: 1080, height: 1920 },
      "fr",
    );
    expect(svg).not.toContain("…");
    expect(svg).toContain("99.00 $");
  });

  it("a hero slide renders centered text with no price", () => {
    const svg = buildSlideOverlaySvg(
      { image_url: "https://images.unsplash.com/photo-1", overlay_text: "☀️ Ta terrasse t'attend", price: 0, hero: true },
      { width: 1080, height: 1920 },
      "fr",
    );
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).not.toContain("$"); // no price on a hero
  });
});

describe("hero slide validation (quality v2)", () => {
  it("accepts an Unsplash image only for a hero item, not a product item", () => {
    const unsplash = "https://images.unsplash.com/photo-1";
    // hero: allowed, and no price required
    const heroOk = validateSlideshowConfig(
      config({ items: [{ image_url: unsplash, overlay_text: "hook", price: 0, hero: true }] }),
    );
    expect(heroOk.valid).toBe(true);
    // same Unsplash url as a normal product slide: rejected
    const productBad = validateSlideshowConfig(config({ items: [item({ image_url: unsplash })] }));
    expect(productBad.valid).toBe(false);
    expect(productBad.errors.join(" ")).toMatch(/unsplash|cdn\.shopify/);
  });
});

describe("pure render helpers", () => {
  it("maps ratios to pixel dimensions", () => {
    expect(ratioDimensions("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(ratioDimensions("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(ratioDimensions("16:9")).toEqual({ width: 1920, height: 1080 });
  });

  it("estimates duration with crossfade overlaps", () => {
    // intro(1.2) + 2 slides(2.4) + outro(1.3) = 7.3, minus 3 xfades * 0.28 = 6.46
    expect(estimateDurationSec(2)).toBe(6.46);
  });

  it("paces to a target total duration when requested", () => {
    // A 12s target over 5 slides lands on (about) 12s, not the default pacing.
    expect(estimateDurationSec(5, 12)).toBeCloseTo(12, 1);
    // The default (no target) stays the fixed pacing.
    expect(perSlideSeconds(5)).toBe(2.4);
    // A reachable target solves the per-slide hold within the clamp.
    const ps = perSlideSeconds(5, 12);
    expect(ps).toBeGreaterThanOrEqual(1.5);
    expect(ps).toBeLessThanOrEqual(4);
    // An absurdly long target clamps the per-slide hold to the max.
    expect(perSlideSeconds(3, 999)).toBe(4);
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
    // Junctions rotate through the transition set (not a flat fade).
    expect(filterComplex).toContain("xfade=transition=slideleft");
    expect(filterComplex).toContain("xfade=transition=smoothleft");
    expect(filterComplex).toContain("afade=t=in:st=0:d=0.3");
    expect(filterComplex).toContain("afade=t=out:st=4.5:d=2");
  });
});

describe("dynamic transitions + Ken Burns (quality v3)", () => {
  it("rotates xfade transitions for normal templates, hard-cuts urgency/price-drop", () => {
    // 4 segments → 3 junctions. Normal → rotation; hard-cut → all 'fade'.
    expect(transitionsFor(SlideshowTemplate.BEST_SELLERS, 4)).toEqual([
      "slideleft", "smoothleft", "wiperight",
    ]);
    expect(transitionsFor(SlideshowTemplate.URGENCY, 4)).toEqual(["fade", "fade", "fade"]);
    expect(transitionsFor(SlideshowTemplate.PRICE_DROP, 3)).toEqual(["fade", "fade"]);
  });

  it("uses a near-zero crossfade (hard cut) for urgency/price-drop only", () => {
    expect(xfadeSecFor(SlideshowTemplate.URGENCY)).toBe(0.04);
    expect(xfadeSecFor(SlideshowTemplate.PRICE_DROP)).toBe(0.04);
    expect(xfadeSecFor(SlideshowTemplate.BEST_SELLERS)).toBe(0.28);
  });

  it("alternates zoom-in / zoom-out and rotates the pan anchor per slide", () => {
    const a = kenBurnsExpr(0); // zoom-in, top-left
    expect(a.z).toContain("min(zoom+");
    expect(a.x).toBe("0");
    expect(a.y).toBe("0");
    const b = kenBurnsExpr(1); // zoom-out, top-right
    expect(b.z).toContain("max(zoom-");
    expect(b.x).toBe("iw-iw/zoom");
    expect(b.y).toBe("0");
    const c = kenBurnsExpr(2); // zoom-in, bottom-left
    expect(c.z).toContain("min(zoom+");
    expect(c.x).toBe("0");
    expect(c.y).toBe("ih-ih/zoom");
  });
});

describe("product overlay legibility + persistent CTA (quality v3)", () => {
  it("adds a navy scrim, text stroke, and a store-URL CTA pill on product slides", () => {
    const svg = buildSlideOverlaySvg(
      { image_url: `${CDN}/x.jpg`, overlay_text: "Chaise de jardin", price: 100, compare_at: 130 },
      { width: 1080, height: 1920 },
      "fr",
      "ameublodirect.ca",
    );
    expect(svg).toContain('opacity="0.55"'); // scrim behind title/price
    expect(svg).toContain('stroke-width="2"'); // text stroke for legibility
    expect(svg).toContain("ameublodirect.ca"); // persistent CTA pill
    expect(svg).toContain("-23%"); // discount badge still renders ((130-100)/130 ≈ 23%)
  });
});
