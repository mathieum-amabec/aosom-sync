import { describe, it, expect } from "vitest";
import { computeSellPrice, profitFloor, TARGET_MARGIN, MAX_MARKUP, OUTDOOR_MAX_MARKUP } from "@/lib/sell-price-rule";
import { planSellPrices, type SellPriceRow } from "@/lib/sell-price-sync";

const margin = (price: number, cost: number) => (price - cost) / price;

describe("computeSellPrice with our cost (no competitor)", () => {
  it("aims for the target margin on cost", () => {
    // Aosom public 100, cost 86 (14 % margin today): 20 % needs 107.50 -> 106.99 after rounding down to .99
    const r = computeSellPrice({ aosomPrice: 100, cost: 86, productType: "Home Furnishings" });
    expect(r.reason).toBe("margin");
    expect(r.price).toBe(106.99);
    expect(margin(r.price, 86)).toBeGreaterThan(TARGET_MARGIN - 0.01);
  });

  it("never exceeds the +15 % cap, even if the margin target would", () => {
    const r = computeSellPrice({ aosomPrice: 100, cost: 95, productType: "Home Furnishings" });
    expect(r.price).toBeLessThanOrEqual(100 * (1 + MAX_MARKUP));
    expect(r.price).toBe(114.99);
  });

  it("...unless the cap would sell at a loss: the profit floor wins (2026-10-18)", () => {
    const r = computeSellPrice({ aosomPrice: 100, cost: 99, productType: "Home Furnishings" });
    expect(r.reason).toBe("profit");
    expect(r.price).toBe(profitFloor(99));
    expect(r.price).toBeGreaterThan(100 * (1 + MAX_MARKUP));
  });

  it("keeps the tiered markup when it is already above the margin price", () => {
    // cost 70 -> margin price 87.5 < tier price 107 : tier wins
    const r = computeSellPrice({ aosomPrice: 100, cost: 70, productType: "Home Furnishings" });
    expect(r.reason).toBe("tier");
    expect(r.price).toBe(106.99);
  });

  it("lets outdoor items rise at most 7 %", () => {
    const r = computeSellPrice({ aosomPrice: 100, cost: 90, productType: "Patio & Garden > Gazebos" });
    expect(r.price).toBeLessThanOrEqual(100 * (1 + OUTDOOR_MAX_MARKUP));
    expect(r.price).toBe(106.99);
  });

  it("never goes below the Aosom floor", () => {
    const r = computeSellPrice({ aosomPrice: 100, cost: 40, productType: "Patio & Garden" });
    expect(r.price).toBeGreaterThanOrEqual(100);
  });

  it("falls back to the tiers when cost is unknown or invalid", () => {
    expect(computeSellPrice({ aosomPrice: 100, productType: "Home Furnishings" })).toMatchObject({ price: 106.99, reason: "tier" });
    expect(computeSellPrice({ aosomPrice: 100, cost: 0, productType: "Home Furnishings" })).toMatchObject({ price: 106.99, reason: "tier" });
    expect(computeSellPrice({ aosomPrice: 100, cost: NaN, productType: "Home Furnishings" }).reason).toBe("tier");
  });
});

describe("computeSellPrice with a competitor", () => {
  it("stays below the competitor even when that leaves under the target margin", () => {
    // cost 85, competitor 103 -> price 101.99 (margin 16.7 %, still profitable with 10 % off): the competitor wins
    const r = computeSellPrice({ aosomPrice: 100, cost: 85, competitorPrice: 103 });
    expect(r.price).toBe(101.99);
    expect(r.price).toBeLessThan(103);
  });

  it("...but not below the profit floor (2026-10-18)", () => {
    // cost 90: 101.99 loses money with 10 % off + card fees, so the price goes up to the profit floor
    const r = computeSellPrice({ aosomPrice: 100, cost: 90, competitorPrice: 103 });
    expect(r).toMatchObject({ price: profitFloor(90), reason: "profit" });
  });

  it("the cost does not change the competitor-based price", () => {
    const a = computeSellPrice({ aosomPrice: 100, competitorPrice: 112 });
    const b = computeSellPrice({ aosomPrice: 100, competitorPrice: 112, cost: 70 });
    expect(a).toEqual(b);
  });
});

describe("planSellPrices passes the cost through", () => {
  const row = (sku: string, cost: number | null): SellPriceRow => ({ sku, aosomPrice: 100, productType: "Home Furnishings", sellPrice: null, cost });
  it("prices a product with a known cost from its margin", () => {
    const plan = planSellPrices([row("A", 86)], new Map());
    expect(plan.changes[0]).toMatchObject({ sku: "A", to: 106.99, reason: "margin" });
  });
  it("uses the tier for a product with no cost", () => {
    const plan = planSellPrices([row("B", null)], new Map());
    expect(plan.changes[0]).toMatchObject({ sku: "B", reason: "tier" });
  });
});
