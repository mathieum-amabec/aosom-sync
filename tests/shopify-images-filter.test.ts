import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Shopify client + env so the resolver runs without network/credentials.
const shop = vi.hoisted(() => ({ shopifyFetch: vi.fn() }));
vi.mock("@/lib/shopify-client", () => shop);
vi.mock("@/lib/config", () => ({ env: { hasShopifyToken: true } }));

import {
  resolveProductImages,
  isSpecImageUrl,
  clearImageCache,
  __setImageResolverForTests,
  resolveLifestyle,
  clearLifestyleCache,
  __setLifestyleResolverForTests,
} from "@/lib/selectors/shopify-images";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

beforeEach(() => {
  clearImageCache();
  clearLifestyleCache();
  __setImageResolverForTests(null); // ensure the real default resolver is active
  __setLifestyleResolverForTests(null);
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

  it("ignoreShopifyUuid: -b0..-f0 inside Shopify's _<uuid> re-upload suffix don't count (2026-10-21)", () => {
    // live cases from feed_integrity_audit: good colour photos dropped from the ad feeds
    const o = { ignoreShopifyUuid: true };
    expect(isSpecImageUrl(`${CDN}/aJ8dc419f1f2cee58_6baf086d-3cf8-46ad-a384-c01aff82e81c.jpg?v=1782460907`, o)).toBe(false);
    expect(isSpecImageUrl(`${CDN}/gzI80c19c21c69a37_a473c699-5b72-419a-b07f-a7e8e20cee9d.jpg`, o)).toBe(false);
    expect(isSpecImageUrl(`${CDN}/NxS5f11949567c48a_076bd27b-b0a0-4cf3-8a33-632fba6aafb1.jpg`, o)).toBe(false);
    // a real suffix or keyword still counts, uuid or not
    expect(isSpecImageUrl(`${CDN}/824-051-B0_6baf086d-3cf8-46ad-a384-c01aff82e81c.jpg`, o)).toBe(true);
    expect(isSpecImageUrl(`${CDN}/size-chart_076bd27b-b0a0-4cf3-8a33-632fba6aafb1.jpg`, o)).toBe(true);
  });

  it("without the option (selectors, no vision filter) the uuid still counts, as before", () => {
    expect(isSpecImageUrl(`${CDN}/aJ8dc419f1f2cee58_6baf086d-3cf8-46ad-a384-c01aff82e81c.jpg`)).toBe(true);
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

describe("resolveLifestyle (default resolver)", () => {
  it("verified=true (tag match is case/space-insensitive) + clean pos-1 photo by position", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          tags: "patio, Lifestyle-Verified , best-seller",
          images: [
            { src: `${CDN}/pos2.jpg`, position: 2 },
            { src: `${CDN}/pos1-lifestyle.jpg`, position: 1 }, // lowest position → chosen
          ],
        },
      }),
    });
    expect(await resolveLifestyle("111")).toEqual({
      verified: true,
      primaryImageUrl: `${CDN}/pos1-lifestyle.jpg`,
    });
  });

  it("drops spec + non-cdn images when picking the position-1 photo", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          tags: "lifestyle-verified",
          images: [
            { src: `${CDN}/spec-diagram.jpg`, position: 1 }, // spec → dropped
            { src: "https://img-us.aosomcdn.com/x.jpg", position: 2 }, // non-cdn → dropped
            { src: `${CDN}/clean.jpg`, position: 3 }, // first clean → chosen
          ],
        },
      }),
    });
    expect(await resolveLifestyle("112")).toEqual({ verified: true, primaryImageUrl: `${CDN}/clean.jpg` });
  });

  it("verified=true but primaryImageUrl=null when no clean cdn photo exists", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ product: { tags: "lifestyle-verified", images: [{ src: `${CDN}/spec.jpg`, position: 1 }] } }),
    });
    expect(await resolveLifestyle("113")).toEqual({ verified: true, primaryImageUrl: null });
  });

  it("verified=false when the tag is absent", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ product: { tags: "patio, best-seller", images: [{ src: `${CDN}/x.jpg`, position: 1 }] } }),
    });
    expect(await resolveLifestyle("114")).toEqual({ verified: false, primaryImageUrl: `${CDN}/x.jpg` });
  });

  it("returns a miss on a non-ok response and on a thrown fetch (never throws)", async () => {
    shop.shopifyFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await resolveLifestyle("115")).toEqual({ verified: false, primaryImageUrl: null });

    shop.shopifyFetch.mockRejectedValueOnce(new Error("network"));
    expect(await resolveLifestyle("116")).toEqual({ verified: false, primaryImageUrl: null });
  });

  it("caches per id (second call does not re-fetch) until cleared", async () => {
    shop.shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ product: { tags: "lifestyle-verified", images: [{ src: `${CDN}/h.jpg`, position: 1 }] } }),
    });
    await resolveLifestyle("117");
    await resolveLifestyle("117");
    expect(shop.shopifyFetch).toHaveBeenCalledTimes(1);
    clearLifestyleCache();
    await resolveLifestyle("117");
    expect(shop.shopifyFetch).toHaveBeenCalledTimes(2);
  });
});
