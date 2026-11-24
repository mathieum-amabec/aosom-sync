/**
 * updateShopifyProduct → draft-redirect hook: a status→draft PUT must trigger the redirect,
 * any other update must not, and a failing PUT must not either.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.mock("@/lib/config", () => ({
  env: { shopifyAccessToken: "test-token", hasShopifyToken: true },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  SYNC: { MIN_DISCOUNT_DISPLAY_PERCENT: 10 },
}));
const { redirectOnDraft } = vi.hoisted(() => ({ redirectOnDraft: vi.fn(async () => null) }));
vi.mock("@/lib/draft-redirect", () => ({ redirectOnDraft }));

import { updateShopifyProduct, draftShopifyProduct } from "@/lib/shopify-client";

const ok = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ product: { id: 1 } }), text: async () => "" });

beforeEach(() => {
  mockFetch.mockReset();
  redirectOnDraft.mockClear();
});

describe("updateShopifyProduct draft-redirect hook", () => {
  it("creates the redirect when a product is drafted", async () => {
    mockFetch.mockResolvedValue(ok());
    await updateShopifyProduct("42", { status: "draft", tags: ["auto-drafted"] });
    expect(redirectOnDraft).toHaveBeenCalledWith("42");
    await updateShopifyProduct("44", { status: "archived" });
    expect(redirectOnDraft).toHaveBeenCalledWith("44");
    await draftShopifyProduct("43");
    expect(redirectOnDraft).toHaveBeenCalledWith("43");
  });

  it("never fails the status write when the hook throws", async () => {
    mockFetch.mockResolvedValue(ok());
    redirectOnDraft.mockRejectedValueOnce(new Error("boom"));
    await expect(updateShopifyProduct("42", { status: "draft" })).resolves.toEqual({ id: 1 });
  });

  it("does nothing for other updates", async () => {
    mockFetch.mockResolvedValue(ok());
    await updateShopifyProduct("42", { status: "active" });
    await updateShopifyProduct("42", { tags: ["x"] });
    expect(redirectOnDraft).not.toHaveBeenCalled();
  });

  it("does nothing when the PUT fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422, headers: { get: () => null }, json: async () => ({}), text: async () => "bad" });
    await expect(updateShopifyProduct("42", { status: "draft" })).rejects.toThrow();
    expect(redirectOnDraft).not.toHaveBeenCalled();
  });
});
