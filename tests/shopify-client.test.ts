import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
