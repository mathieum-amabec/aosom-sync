import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Shopify client + env so the resolver runs without network/credentials.
const shop = vi.hoisted(() => ({ shopifyFetch: vi.fn() }));
vi.mock("@/lib/shopify-client", () => shop);
vi.mock("@/lib/config", () => ({ env: { hasShopifyToken: true } }));

import { resolveProductImages, isSpecImageUrl, clearImageCache, __setImageResolverForTests } from "@/lib/selectors/shopify-images";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

beforeEach(() => {
  clearImageCache();
  __setImageResolverForTests(null); // ensure the real default resolver is active
  vi.clearAllMocks();
});

describe("isSpecImageUrl", () => {
  it("flags spec/diagram/infographic shots and the -B0..-F0 suffixes", () => {
    expect(isSpecImageUrl(`${CDN}/chair-diagram.jpg`)).toBe(true);
    expect(isSpecImageUrl(`${CDN}/spec-sheet.png`)).toBe(true);
    expect(isSpecImageUrl(`${CDN}/measurements.jpg`)).toBe(true);
    expect(isSpecImageUrl(`${CDN}/824-051-B0.jpg`)).toBe(true);
    expect(isSpecImageUrl(`${CDN}/824-051-c0.jpg`)).toBe(true);
  });

  it("keeps normal product photos", () => {
    expect(isSpecImageUrl(`${CDN}/824-051-hero.jpg`)).toBe(false);
    expect(isSpecImageUrl(`${CDN}/patio-glider.jpg`)).toBe(false);
  });
});

describe("resolveProductImages (default resolver)", () => {
  it("keeps only the FIRST clean cdn photo (Aosom's white-bg shot at index 0)", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          images: [
            { src: `${CDN}/824-white.jpg` }, // index 0 = official white-bg shot → kept
            { src: `${CDN}/824-lifestyle.jpg` }, // index 1 = ambiance → beyond the 1-image cap
            { src: `${CDN}/diagram-dimensions.jpg` }, // spec → dropped
            { src: "https://img-us.aosomcdn.com/x.jpg" }, // non-cdn → dropped
          ],
        },
      }),
    });

    const urls = await resolveProductImages("123");
    expect(urls).toEqual([`${CDN}/824-white.jpg`]);
  });

  it("falls through to the next clean photo when the first image is a spec shot", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ product: { images: [{ src: `${CDN}/spec.jpg` }, { src: `${CDN}/hero.jpg` }] } }),
    });
    expect(await resolveProductImages("789")).toEqual([`${CDN}/hero.jpg`]);
  });

  it("returns [] when there are no clean cdn images", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ product: { images: [{ src: `${CDN}/spec.jpg` }, { src: "https://other/x.jpg" }] } }),
    });
    expect(await resolveProductImages("456")).toEqual([]);
  });
});
