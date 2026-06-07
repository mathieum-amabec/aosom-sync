import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────
//
// sharp is replaced with a recording stub: every sharp() / sharp({create})
// call pushes a chainable instance into `instances`, capturing resize args and
// the composite layers so we can assert the composition parameters without
// actually rendering pixels.

const { instances, makeSharp } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instances: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeSharp(input: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = { input, resizeArgs: null, composited: null, pngCount: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inst.resize = (...a: any[]) => { inst.resizeArgs = a; return inst; };
    inst.png = () => { inst.pngCount++; return inst; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inst.composite = (c: any) => { inst.composited = c; return inst; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inst.toBuffer = async (opts: any) =>
      opts && opts.resolveWithObject
        ? { data: Buffer.from("img"), info: { width: 100, height: 80 } }
        : Buffer.from("final-png");
    instances.push(inst);
    return inst;
  }
  return { instances, makeSharp };
});

vi.mock("sharp", () => ({ default: makeSharp }));

vi.mock("@/lib/image-composer", () => ({
  downloadImage: vi.fn(async () => Buffer.from("raw-product-bytes")),
}));

import {
  composeProductImage,
  buildBrandedSvg,
  badgeLabel,
  logoPath,
  CANVAS,
  BAND_HEIGHT,
  PRODUCT_MAX_WIDTH,
  PRODUCT_MAX_HEIGHT,
} from "@/lib/image-compositor";
import { downloadImage } from "@/lib/image-composer";

// ─── badgeLabel ─────────────────────────────────────────────────────────

describe("badgeLabel", () => {
  it("maps badge + locale to the right text", () => {
    expect(badgeLabel("fr", "new")).toBe("NOUVEAU");
    expect(badgeLabel("en", "new")).toBe("NEW");
    expect(badgeLabel("fr", "sale")).toBe("SOLDE");
    expect(badgeLabel("en", "sale")).toBe("SALE");
  });

  it("returns null when no badge is requested", () => {
    expect(badgeLabel("fr")).toBeNull();
    expect(badgeLabel("en", undefined)).toBeNull();
  });
});

// ─── logoPath ───────────────────────────────────────────────────────────

describe("logoPath", () => {
  it("points at the locale-specific logo", () => {
    expect(logoPath("fr").replace(/\\/g, "/")).toMatch(/\/Logo\/logo-fr\.png$/);
    expect(logoPath("en").replace(/\\/g, "/")).toMatch(/\/Logo\/logo-en\.png$/);
  });
});

// ─── buildBrandedSvg ────────────────────────────────────────────────────

describe("buildBrandedSvg", () => {
  it("renders a full-width navy footer band at the bottom", () => {
    const svg = buildBrandedSvg({ productImageUrl: "x", price: "10.00 CAD", locale: "fr" });
    expect(svg).toContain(`width="${CANVAS}" height="${CANVAS}"`);
    // Band: navy, full width, BAND_HEIGHT tall, positioned at the band top.
    expect(svg).toContain(`y="${CANVAS - BAND_HEIGHT}" width="${CANVAS}" height="${BAND_HEIGHT}" fill="#1A2340"`);
  });

  it("renders the price right-aligned in white", () => {
    const svg = buildBrandedSvg({ productImageUrl: "x", price: "249.99 CAD", locale: "fr" });
    expect(svg).toContain("249.99 CAD");
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('fill="#FFFFFF"');
  });

  it("renders a copper badge with localized text when a badge is set", () => {
    const fr = buildBrandedSvg({ productImageUrl: "x", price: "10 CAD", locale: "fr", badge: "new" });
    expect(fr).toContain("#C17F3E");
    expect(fr).toContain("NOUVEAU");

    const en = buildBrandedSvg({ productImageUrl: "x", price: "10 CAD", locale: "en", badge: "sale" });
    expect(en).toContain("SALE");
  });

  it("omits the badge when none is requested", () => {
    const svg = buildBrandedSvg({ productImageUrl: "x", price: "10 CAD", locale: "fr" });
    expect(svg).not.toContain("#C17F3E");
    expect(svg).not.toContain("NOUVEAU");
  });

  it("escapes XML-sensitive characters in the price", () => {
    const svg = buildBrandedSvg({ productImageUrl: "x", price: "<b>&amp;</b>", locale: "fr" });
    expect(svg).not.toMatch(/<b>&amp;<\/b>/);
    expect(svg).toContain("&lt;b&gt;");
  });
});

// ─── composeProductImage ────────────────────────────────────────────────

describe("composeProductImage", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.mocked(downloadImage).mockClear();
    vi.mocked(downloadImage).mockResolvedValue(Buffer.from("raw-product-bytes"));
  });

  it("returns the composited PNG buffer", async () => {
    const buf = await composeProductImage({
      productImageUrl: "https://cdn.example.com/p.jpg",
      price: "249.99 CAD",
      locale: "fr",
      badge: "new",
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe("final-png");
  });

  it("builds a 1080×1080 off-white canvas", async () => {
    await composeProductImage({ productImageUrl: "https://cdn/p.jpg", price: "10 CAD", locale: "fr" });
    const base = instances.find((i) => i.input && i.input.create);
    expect(base.input.create).toMatchObject({
      width: 1080,
      height: 1080,
      channels: 4,
      background: "#FAFAF8",
    });
  });

  it("downloads the product photo and resizes it to 80% (contain)", async () => {
    await composeProductImage({ productImageUrl: "https://cdn/p.jpg", price: "10 CAD", locale: "fr" });
    expect(downloadImage).toHaveBeenCalledWith("https://cdn/p.jpg");
    const product = instances.find((i) => i.resizeArgs && i.resizeArgs[0] === PRODUCT_MAX_WIDTH);
    expect(product.resizeArgs).toEqual([
      PRODUCT_MAX_WIDTH,
      PRODUCT_MAX_HEIGHT,
      { fit: "inside", withoutEnlargement: true },
    ]);
  });

  it("composites product photo + branded SVG + logo over the base", async () => {
    await composeProductImage({ productImageUrl: "https://cdn/p.jpg", price: "10 CAD", locale: "fr", badge: "new" });
    const base = instances.find((i) => i.input && i.input.create);
    expect(base.composited).toHaveLength(3);
    const svgLayer = base.composited
      .map((c: { input: Buffer }) => c.input)
      .find((b: Buffer) => Buffer.isBuffer(b) && b.toString().includes("#1A2340"));
    expect(svgLayer).toBeTruthy();
    expect(svgLayer.toString()).toContain("NOUVEAU");
    expect(svgLayer.toString()).toContain("10 CAD");
  });

  it("falls back to a blank product area when the photo download fails", async () => {
    vi.mocked(downloadImage).mockRejectedValueOnce(new Error("network"));
    const buf = await composeProductImage({ productImageUrl: "https://cdn/bad.jpg", price: "10 CAD", locale: "fr" });
    expect(buf.toString()).toBe("final-png");
    // Only the SVG band + logo were composited (no product layer).
    const base = instances.find((i) => i.input && i.input.create);
    expect(base.composited).toHaveLength(2);
  });
});
