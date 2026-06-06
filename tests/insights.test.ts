import { describe, it, expect } from "vitest";
import { storeLink } from "@/lib/insights";
import { SHOPIFY } from "@/lib/config";

const ADMIN = "https://admin.shopify.com/store/test-store";

describe("storeLink", () => {
  it("marks a product with a shopify id as in store and links to the admin product page", () => {
    const r = storeLink("123456789", ADMIN);
    expect(r.inStore).toBe(true);
    expect(r.shopifyUrl).toBe("https://admin.shopify.com/store/test-store/products/123456789");
  });

  it("accepts a numeric id and coerces it to a string", () => {
    const r = storeLink(987654321, ADMIN);
    expect(r.inStore).toBe(true);
    expect(r.shopifyUrl).toBe("https://admin.shopify.com/store/test-store/products/987654321");
  });

  it("treats null as not imported", () => {
    expect(storeLink(null, ADMIN)).toEqual({ inStore: false, shopifyUrl: null });
  });

  it("treats undefined as not imported", () => {
    expect(storeLink(undefined, ADMIN)).toEqual({ inStore: false, shopifyUrl: null });
  });

  it("treats empty string as not imported", () => {
    expect(storeLink("", ADMIN)).toEqual({ inStore: false, shopifyUrl: null });
  });

  it("treats a whitespace-only id as not imported (no bogus link)", () => {
    expect(storeLink("   ", ADMIN)).toEqual({ inStore: false, shopifyUrl: null });
  });

  it("trims surrounding whitespace from a real id", () => {
    const r = storeLink("  42 ", ADMIN);
    expect(r.inStore).toBe(true);
    expect(r.shopifyUrl).toBe("https://admin.shopify.com/store/test-store/products/42");
  });

  it("defaults to the configured Shopify admin base url", () => {
    const r = storeLink("55");
    expect(r.shopifyUrl).toBe(`${SHOPIFY.ADMIN_URL}/products/55`);
  });
});
