import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

// Real sharp, real logo files, real SVG parse + composite. Only the network
// download is stubbed (with a real generated PNG) so the test is hermetic.
// This catches what the unit tests (which mock sharp) cannot: a malformed SVG,
// a missing/undecodable logo, or a broken composite pipeline.
vi.mock("@/lib/image-composer", () => ({ downloadImage: vi.fn() }));

import { composeProductImage, CANVAS } from "@/lib/image-compositor";
import { downloadImage } from "@/lib/image-composer";

describe("composeProductImage (real sharp render)", () => {
  beforeEach(async () => {
    // A real 800×800 red PNG stands in for the downloaded Aosom product photo.
    const fakeProduct = await sharp({
      create: { width: 800, height: 800, channels: 3, background: "#cc0000" },
    })
      .png()
      .toBuffer();
    vi.mocked(downloadImage).mockResolvedValue(fakeProduct);
  });

  it("produces a valid 1080×1080 PNG with FR logo + badge", async () => {
    const png = await composeProductImage({
      productImageUrl: "https://cdn.example.com/p.jpg",
      price: "249.99 CAD",
      locale: "fr",
      badge: "new",
    });
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(CANVAS);
    expect(meta.height).toBe(CANVAS);
    expect(png.byteLength).toBeGreaterThan(1000); // not an empty/degenerate image
  });

  it("renders for EN locale without a badge", async () => {
    const png = await composeProductImage({
      productImageUrl: "https://cdn.example.com/p.jpg",
      price: "199.00 CAD",
      locale: "en",
    });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(CANVAS);
    expect(meta.height).toBe(CANVAS);
  });

  it("still renders a valid image when the product download fails", async () => {
    vi.mocked(downloadImage).mockRejectedValueOnce(new Error("network"));
    const png = await composeProductImage({
      productImageUrl: "https://cdn.example.com/bad.jpg",
      price: "10.00 CAD",
      locale: "fr",
    });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(CANVAS);
    expect(meta.height).toBe(CANVAS);
  });
});
