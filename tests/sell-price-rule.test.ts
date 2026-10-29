import { describe, it, expect } from "vitest";
import { computeSellPrice, netProfit, profitFloor, roundDownTo99 } from "@/lib/sell-price-rule";

describe("roundDownTo99", () => {
  it("rounds down to the nearest .99, never up", () => {
    expect(roundDownTo99(257.99)).toBe(257.99);
    expect(roundDownTo99(258.5)).toBe(257.99);
    expect(roundDownTo99(258.99)).toBe(258.99);
    expect(roundDownTo99(259.0)).toBe(258.99);
    expect(roundDownTo99(100)).toBe(99.99);
  });
  it("leaves tiny or invalid values alone", () => {
    expect(roundDownTo99(0.5)).toBe(0.5);
    expect(roundDownTo99(NaN)).toBeNaN();
  });
});

describe("computeSellPrice — the Aosom price (Mat, 2026-10-28)", () => {
  it("sells at the Aosom price when it covers our cost", () => {
    // 83A-705V02GN: cost 238.17, Aosom 292.99 (we were at 309.99)
    expect(computeSellPrice({ aosomPrice: 292.99, cost: 238.17 })).toEqual({ price: 292.99, reason: "floor", competitorIgnored: false });
  });
  it("ignores the competitor price and the product type", () => {
    const r = computeSellPrice({ aosomPrice: 139.99, cost: 115.64, competitorPrice: 199.99, productType: "Patio & Garden" });
    expect(r.price).toBe(139.99);
    expect(r.reason).toBe("floor");
  });
  it("sells at the Aosom price when the cost is unknown", () => {
    expect(computeSellPrice({ aosomPrice: 89.99, cost: null }).price).toBe(89.99);
  });
  it("stays just above Aosom when the Aosom price would sell at a loss", () => {
    const cost = 300;
    const r = computeSellPrice({ aosomPrice: 299.99, cost });
    expect(r.reason).toBe("profit");
    expect(r.price).toBe(profitFloor(cost));
    expect(r.price).toBeGreaterThan(299.99);
    expect(netProfit(r.price, cost)).toBeGreaterThan(0);
  });
  it("returns NaN for an invalid Aosom price", () => {
    expect(computeSellPrice({ aosomPrice: 0, cost: 10 }).price).toBeNaN();
    expect(computeSellPrice({ aosomPrice: NaN }).price).toBeNaN();
  });
});

describe("profitFloor (list price, after card fees)", () => {
  it("clears the cost by about 2 % at list price and ends in .99", () => {
    for (const cost of [5, 19.9, 74.17, 167.95, 750.34, 2400]) {
      const p = profitFloor(cost);
      expect(netProfit(p, cost)).toBeGreaterThanOrEqual(Math.round(cost * 0.02 * 100) / 100 - 0.01);
      expect(Math.round((p % 1) * 100)).toBe(99);
    }
  });
  it("is about cost × 1.05 + 0.31 $ (no discount assumed any more)", () => {
    expect(profitFloor(100)).toBe(105.99);
  });
});
