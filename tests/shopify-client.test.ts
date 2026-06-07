import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock config to avoid env var requirement
vi.mock("@/lib/config", () => ({
  env: { shopifyAccessToken: "test-token", hasShopifyToken: true },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  SYNC: { MIN_DISCOUNT_DISPLAY_PERCENT: 10 },
}));

// Import after mocks
const { updateShopifyVariantPrice, createShopifyProduct } = await import("@/lib/shopify-client");

import type { AosomMergedProduct } from "@/types/aosom";
import type { GeneratedContent } from "@/lib/content-generator";

function mergedFixture(): AosomMergedProduct {
  return {
    groupKey: "g1",
    name: "Chaise longue grise",
    brand: "Outsunny",
    productType: "Patio & Garden",
    category: "Patio",
    description: "",
    shortDescription: "",
    material: "",
    images: ["https://img/1.jpg"],
    video: "",
    pdf: "",
    variants: [
      {
        sku: "SKU1", price: 99, qty: 1, color: "Gris", size: "", gtin: "",
        weight: 1, dimensions: { length: 0, width: 0, height: 0 }, images: [],
        estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "",
      },
    ],
  } as unknown as AosomMergedProduct;
}

function contentFixture(over: Partial<GeneratedContent> = {}): GeneratedContent {
  return {
    titleFr: "Chaise longue grise",
    titleEn: "Grey lounge chair",
    descriptionFr: "<p>fr</p>",
    descriptionEn: "<p>en</p>",
    seoDescriptionFr: "s-fr",
    seoDescriptionEn: "s-en",
    metaTitleFr: "Chaise | Livraison gratuite — Ameublo Direct",
    metaTitleEn: "Grey | Free Shipping — Furnish Direct",
    metaDescriptionFr: "desc fr",
    metaDescriptionEn: "desc en",
    urlHandleFr: "chaise-longue-grise",
    urlHandleEn: "grey-lounge-chair",
    tags: ["jardin"],
    brand: "Outsunny",
    ...over,
  };
}

describe("createShopifyProduct — metafield + handle safety", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ product: { id: 555 } }) });
  });

  it("drops metafields whose value is empty (would 422 the whole create)", async () => {
    // Empty metaTitleFr must NOT be sent as an empty global.title_tag.
    await createShopifyProduct(mergedFixture(), contentFixture({ metaTitleFr: "" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const mf = body.product.metafields as Array<{ namespace: string; key: string; value: string }>;
    expect(mf.every((m) => typeof m.value === "string" && m.value.trim() !== "")).toBe(true);
    expect(mf.find((m) => m.namespace === "global" && m.key === "title_tag")).toBeUndefined();
    // The non-empty ones survive.
    expect(mf.find((m) => m.namespace === "global" && m.key === "description_tag")?.value).toBe("desc fr");
    expect(mf.find((m) => m.key === "brand_fr")?.value).toBe("Outsunny");
  });

  it("falls back to a title-derived handle when urlHandleFr is empty", async () => {
    await createShopifyProduct(mergedFixture(), contentFixture({ urlHandleFr: "" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.product.handle).toBe("chaise-longue-grise");
  });

  it("uses the model handle when present", async () => {
    await createShopifyProduct(mergedFixture(), contentFixture({ urlHandleFr: "custom-slug" }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.product.handle).toBe("custom-slug");
  });

  it("publishes the product live (status active) on import", async () => {
    await createShopifyProduct(mergedFixture(), contentFixture({}));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.product.status).toBe("active");
  });
});

describe("shopifyFetch — AbortError / timeout", () => {
  beforeEach(() => mockFetch.mockReset());

  it("converts AbortError to a friendly timeout message", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mockFetch.mockRejectedValueOnce(abortError);
    await expect(updateShopifyVariantPrice("v1", 29.99)).rejects.toThrow(/timeout after 25s/);
  });

  it("rethrows non-abort network errors unchanged", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(updateShopifyVariantPrice("v1", 29.99)).rejects.toThrow("ECONNREFUSED");
  });
});

describe("shopifyFetch — 429 rate limiting", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once after a 429 response", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => "0.001" } })
      .mockResolvedValue({ ok: true, json: async () => ({}) });

    const promise = updateShopifyVariantPrice("v1", 29.99);
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws rate limit error after max retries", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 429, headers: { get: () => "0.001" } });

    const promiseSettle = updateShopifyVariantPrice("v1", 29.99).then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, message: err.message })
    );
    // Advance through all 3 retry delays
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promiseSettle;
    expect(result.ok).toBe(false);
    expect((result as { ok: false; message: string }).message).toMatch(/rate limit exceeded after 3 retries/);
  });

  it("caps Retry-After at 30 seconds when header is larger", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => "60" } })
      .mockResolvedValue({ ok: true, json: async () => ({}) });

    const promise = updateShopifyVariantPrice("v1", 29.99);
    await vi.advanceTimersByTimeAsync(29_999);
    // still pending — not yet 30s
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    // retry fired at 30s (cap), not 60s
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("updateShopifyVariantPrice", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it("sets compare_at_price on a price drop at/above the threshold", async () => {
    // 39.99 -> 29.99 is a 25% drop, above the 10% threshold.
    await updateShopifyVariantPrice("variant-1", 29.99, 39.99);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.variant.price).toBe("29.99");
    expect(body.variant.compare_at_price).toBe("39.99");
  });

  it("clears compare_at_price on a sub-threshold drop (< MIN_DISCOUNT_DISPLAY_PERCENT)", async () => {
    // 100 -> 99 is a 1% drop, below the 10% threshold: no fake "sale".
    await updateShopifyVariantPrice("variant-1", 99, 100);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.variant.price).toBe("99");
    expect(body.variant.compare_at_price).toBeNull();
  });

  it("clears compare_at_price on price increase", async () => {
    await updateShopifyVariantPrice("variant-1", 49.99, 39.99);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.variant.price).toBe("49.99");
    expect(body.variant.compare_at_price).toBeNull();
  });

  it("omits compare_at_price when oldPrice not provided", async () => {
    await updateShopifyVariantPrice("variant-1", 29.99);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.variant.price).toBe("29.99");
    expect(body.variant).not.toHaveProperty("compare_at_price");
  });
});
