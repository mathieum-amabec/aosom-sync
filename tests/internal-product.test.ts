import { describe, it, expect } from "vitest";
import { isInternalProduct } from "@/lib/internal-product";

describe("isInternalProduct", () => {
  it("matches the warranty by product_type", () => {
    expect(isInternalProduct({ product_type: "Garantie" })).toBe(true);
    expect(isInternalProduct({ product_type: " Garantie " })).toBe(true);
  });
  it("matches the internal-warranty tag (string or array, any case)", () => {
    expect(isInternalProduct({ tags: "promo, Internal-Warranty" })).toBe(true);
    expect(isInternalProduct({ tags: ["internal-warranty"] })).toBe(true);
  });
  it("ignores furniture", () => {
    expect(isInternalProduct({ product_type: "Fauteuils", tags: "src-c, garantie-2-ans" })).toBe(false);
    expect(isInternalProduct({})).toBe(false);
  });
});
