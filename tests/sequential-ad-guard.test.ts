import { describe, it, expect } from "vitest";
import { checkSequentialAdQuality, extractSkuFromContentId } from "@/lib/sequential-ad-guard";

describe("extractSkuFromContentId", () => {
  it("extracts the sku from a well-formed content_id", () => {
    expect(extractSkuFromContentId("seqad:hero_slides:patio-ete-2026:84B-206BK")).toBe("84B-206BK");
  });

  it("returns null for a malformed content_id", () => {
    expect(extractSkuFromContentId("not-a-seqad-id")).toBeNull();
    expect(extractSkuFromContentId("seqad:hero_slides")).toBeNull();
  });
});

describe("checkSequentialAdQuality", () => {
  const okUrl = async () => ({ ok: true, status: 200 });
  const okProduct = async () => ({ qty: 10, shopify_product_id: "123" });

  it("passes a well-formed, reachable, in-stock draft", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "Chaise longue", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: okProduct },
    );
    expect(result.passes).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("flags an empty caption", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: okProduct },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("caption"))).toBe(true);
  });

  it("flags a placeholder caption", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "undefined", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: okProduct },
    );
    expect(result.passes).toBe(false);
  });

  it("flags a missing video URL", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "Chaise longue", reelsVideoUrl: undefined },
      { checkUrlReachable: okUrl, lookupProduct: okProduct },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("reelsVideoUrl"))).toBe(true);
  });

  it("flags a malformed video URL without making a network call", async () => {
    let called = false;
    const spyUrl = async () => {
      called = true;
      return { ok: true };
    };
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "Chaise longue", reelsVideoUrl: "not-a-url" },
      { checkUrlReachable: spyUrl, lookupProduct: okProduct },
    );
    expect(result.passes).toBe(false);
    expect(called).toBe(false);
  });

  it("flags an unreachable video URL (404)", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "Chaise longue", reelsVideoUrl: "https://example.com/gone.mp4" },
      { checkUrlReachable: async () => ({ ok: false, status: 404 }), lookupProduct: okProduct },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("404"))).toBe(true);
  });

  it("flags a product that no longer exists", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:GONE-SKU", caption: "Chaise longue", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: async () => null },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("no longer exists"))).toBe(true);
  });

  it("flags a product that is now out of stock", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "Chaise longue", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: async () => ({ qty: 0, shopify_product_id: "123" }) },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("out of stock"))).toBe(true);
  });

  it("flags a product that is no longer imported on Shopify", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "Chaise longue", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: async () => ({ qty: 10, shopify_product_id: null }) },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("no longer imported"))).toBe(true);
  });

  it("flags a malformed content_id", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "garbage", caption: "Chaise longue", reelsVideoUrl: "https://example.com/v.mp4" },
      { checkUrlReachable: okUrl, lookupProduct: okProduct },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.some((r) => r.includes("does not match"))).toBe(true);
  });

  it("collects multiple simultaneous failure reasons", async () => {
    const result = await checkSequentialAdQuality(
      { contentId: "seqad:hero_slides:patio-ete-2026:84B-206BK", caption: "", reelsVideoUrl: undefined },
      { checkUrlReachable: okUrl, lookupProduct: async () => ({ qty: 0, shopify_product_id: null }) },
    );
    expect(result.passes).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
