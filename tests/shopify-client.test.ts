import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock config to avoid env var requirement
vi.mock("@/lib/config", () => ({
  env: { shopifyAccessToken: "test-token", hasShopifyToken: true },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
}));

// Import after mocks
const { updateShopifyVariantPrice } = await import("@/lib/shopify-client");

describe("updateShopifyVariantPrice", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it("sets compare_at_price on price drop", async () => {
    await updateShopifyVariantPrice("variant-1", 29.99, 39.99);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.variant.price).toBe("29.99");
    expect(body.variant.compare_at_price).toBe("39.99");
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
