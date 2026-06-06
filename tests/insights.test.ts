import { describe, it, expect } from "vitest";
import { storeLink, STOREFRONT_BASE_URL } from "@/lib/insights";
import { SHOPIFY } from "@/lib/config";

const ADMIN = "https://admin.shopify.com/store/test-store";
const opts = { adminBaseUrl: ADMIN };

describe("storeLink — storefront handle preferred, admin fallback", () => {
  it("prefers the storefront /products/{handle} when a handle is present", () => {
    const r = storeLink("123456789", "chaise-longue-grise", opts);
    expect(r.inStore).toBe(true);
    expect(r.shopifyUrl).toBe(`${STOREFRONT_BASE_URL}/products/chaise-longue-grise`);
  });

  it("falls back to the admin product page when no handle is known", () => {
    const r = storeLink("123456789", null, opts);
    expect(r.inStore).toBe(true);
    expect(r.shopifyUrl).toBe(`${ADMIN}/products/123456789`);
  });

  it("falls back to admin when handle is blank/whitespace", () => {
    expect(storeLink("42", "   ", opts).shopifyUrl).toBe(`${ADMIN}/products/42`);
  });

  it("treats a product with neither id nor handle as not imported", () => {
    expect(storeLink(null, null, opts)).toEqual({ inStore: false, shopifyUrl: null });
    expect(storeLink(undefined, undefined, opts)).toEqual({ inStore: false, shopifyUrl: null });
    expect(storeLink("", "", opts)).toEqual({ inStore: false, shopifyUrl: null });
  });

  it("is in store via handle even if the numeric id is missing", () => {
    const r = storeLink(null, "some-handle", opts);
    expect(r.inStore).toBe(true);
    expect(r.shopifyUrl).toBe(`${STOREFRONT_BASE_URL}/products/some-handle`);
  });

  it("coerces a numeric id and trims whitespace for the admin fallback", () => {
    expect(storeLink(987654321, null, opts).shopifyUrl).toBe(`${ADMIN}/products/987654321`);
    expect(storeLink("  55 ", null, opts).shopifyUrl).toBe(`${ADMIN}/products/55`);
  });

  it("defaults to the configured Shopify admin base + public storefront base", () => {
    expect(storeLink("55").shopifyUrl).toBe(`${SHOPIFY.ADMIN_URL}/products/55`);
    expect(storeLink("55", "the-handle").shopifyUrl).toBe(`${STOREFRONT_BASE_URL}/products/the-handle`);
  });
});
