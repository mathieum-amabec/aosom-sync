import { describe, it, expect } from "vitest";
import { targetSellPrice, isBelowFloor, PRICE_MARKUP } from "@/lib/pricing";

describe("targetSellPrice (Aosom price = 0% markup target + absolute floor)", () => {
  it("sells at exactly the Aosom price with the current 0% markup", () => {
    expect(PRICE_MARKUP).toBe(0);
    expect(targetSellPrice(85.99)).toBe(85.99);
    expect(targetSellPrice(89.99)).toBe(89.99);
  });

  it("never returns a price below the Aosom input (the floor)", () => {
    for (const p of [0.01, 5, 73.99, 85.99, 1000]) {
      expect(targetSellPrice(p)).toBeGreaterThanOrEqual(p);
    }
  });

  it("returns NaN (not 0) for non-finite / non-positive inputs so callers skip — never push $0", () => {
    expect(targetSellPrice(0)).toBeNaN();
    expect(targetSellPrice(-10)).toBeNaN();
    expect(targetSellPrice(NaN)).toBeNaN();
    expect(targetSellPrice(Infinity)).toBeNaN();
  });
});

describe("isBelowFloor", () => {
  it("flags a Shopify price under the Aosom floor (1-cent tolerance)", () => {
    expect(isBelowFloor(79.99, 85.99)).toBe(true);
    expect(isBelowFloor(85.99, 85.99)).toBe(false);
    expect(isBelowFloor(85.985, 85.99)).toBe(false); // within tolerance
    expect(isBelowFloor(120, 85.99)).toBe(false);
  });
});
