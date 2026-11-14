import { describe, it, expect } from "vitest";
import { computeSellPrice, estimatedAosomPrice, floorPrice, hasSignatureEnding, netProfit, profitFloor, roundDownTo88, roundDownTo99, roundUpTo88, signaturePrice } from "@/lib/sell-price-rule";

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

describe(".88 rounding", () => {
  it("rounds up and down to .88", () => {
    expect(roundUpTo88(86.5)).toBe(86.88);
    expect(roundUpTo88(86.88)).toBe(86.88);
    expect(roundUpTo88(86.9)).toBe(87.88);
    expect(roundDownTo88(86.9)).toBe(86.88);
    expect(roundDownTo88(86.5)).toBe(85.88);
  });
  it("recognises the signature ending", () => {
    expect(hasSignatureEnding(255.88)).toBe(true);
    expect(hasSignatureEnding(255.99)).toBe(false);
    expect(hasSignatureEnding(null)).toBe(false);
  });
});

describe("signaturePrice — .88, never just over a round number", () => {
  it("keeps the .88 of the target's dollar", () => {
    expect(signaturePrice(255.53)).toBe(255.88);
    expect(signaturePrice(104.0)).toBe(104.88);
    expect(signaturePrice(5.2)).toBe(5.88);
  });
  it("drops under a round number it barely passes", () => {
    expect(signaturePrice(301.2)).toBe(299.88);
    expect(signaturePrice(60.5)).toBe(59.88);
    expect(signaturePrice(1001)).toBe(999.88);
  });
  it("is NaN for an invalid target", () => {
    expect(signaturePrice(0)).toBeNaN();
    expect(signaturePrice(NaN)).toBeNaN();
  });
});

describe("floorPrice — the frozen Aosom price in .88, unless that crosses a round number", () => {
  it("rounds up to .88 within the same ten / hundred", () => {
    expect(floorPrice(63.99)).toBe(64.88);
    expect(floorPrice(292.99)).toBe(293.88);
  });
  it("keeps the price as it is when its .88 would cross a round number", () => {
    expect(floorPrice(299.99)).toBe(299.99);
    expect(floorPrice(99.99)).toBe(99.99);
    expect(floorPrice(59.95)).toBe(59.95);
  });
});

describe("estimatedAosomPrice — cost × 1.15 (8 real aosom.ca prices, 2026-11-09)", () => {
  it("lands within a few percent of Aosom's real price", () => {
    // [cost, real aosom.ca price]
    const cases: Array<[number, number]> = [[222.2, 259.99], [53.87, 63.99], [101.61, 108.99], [103.37, 122.99], [112.03, 124.99], [275.17, 304.99], [399.38, 474.99], [691.23, 782.99]];
    for (const [cost, real] of cases) expect(Math.abs(estimatedAosomPrice(cost) / real - 1)).toBeLessThan(0.08);
    expect(estimatedAosomPrice(222.2)).toBe(255.88);
    expect(estimatedAosomPrice(691.23)).toBe(794.88);
  });
  it("is NaN without a cost", () => {
    expect(estimatedAosomPrice(null)).toBeNaN();
  });
});

describe("computeSellPrice — our estimate of Aosom's price (Mat, 2026-11-09)", () => {
  it("sells at the estimate when it is above the frozen Aosom price", () => {
    // 921-683V83BK: cost 222.20, frozen Aosom 204.99, real aosom.ca 259.99 that day
    expect(computeSellPrice({ aosomPrice: 204.99, cost: 222.2 })).toEqual({ price: 255.88, reason: "estimate", competitorIgnored: false });
  });
  it("never goes under the frozen Aosom price (shown as its .88)", () => {
    // 83A-705V02GN: cost 238.17 → estimate 273.88, frozen Aosom 292.99
    expect(computeSellPrice({ aosomPrice: 292.99, cost: 238.17 })).toEqual({ price: 293.88, reason: "floor", competitorIgnored: false });
  });
  it("ignores the competitor price and the product type", () => {
    const r = computeSellPrice({ aosomPrice: 139.99, cost: 115.64, competitorPrice: 199.99, productType: "Patio & Garden" });
    expect(r.price).toBe(140.88);
  });
  it("keeps the frozen Aosom price as it is when the cost is unknown", () => {
    expect(computeSellPrice({ aosomPrice: 89.99, cost: null }).price).toBe(89.99);
  });
  it("prices a frozen price under our cost at the estimate, profitably", () => {
    const r = computeSellPrice({ aosomPrice: 299.99, cost: 300 });
    expect(r).toMatchObject({ price: 345.88, reason: "estimate" });
    expect(netProfit(r.price, 300)).toBeGreaterThan(0);
  });
  it("returns NaN for an invalid Aosom price", () => {
    expect(computeSellPrice({ aosomPrice: 0, cost: 10 }).price).toBeNaN();
    expect(computeSellPrice({ aosomPrice: NaN }).price).toBeNaN();
  });
});

describe("profitFloor (list price, after card fees)", () => {
  it("clears the cost by about 2 % at list price and ends in .88", () => {
    for (const cost of [5, 19.9, 74.17, 167.95, 750.34, 2400]) {
      const p = profitFloor(cost);
      expect(netProfit(p, cost)).toBeGreaterThanOrEqual(Math.round(cost * 0.02 * 100) / 100 - 0.01);
      expect(Math.round((p % 1) * 100)).toBe(88);
    }
  });
  it("is about cost × 1.05 + 0.31 $ (no discount assumed any more)", () => {
    expect(profitFloor(100)).toBe(105.88);
  });
});
