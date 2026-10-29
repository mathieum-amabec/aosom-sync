import { describe, it, expect } from "vitest";
import { computeSellPrice, profitFloor, netProfit, roundUpTo99, FLOOR_DISCOUNT } from "@/lib/sell-price-rule";
import { planSellPrices } from "@/lib/sell-price-sync";
import { evaluateDiscounts, findLosses, maxPerItem, toDiscountInfo, type DiscountInfo } from "@/lib/margin-guard";

const disc = (o: Partial<DiscountInfo>): DiscountInfo => ({
  title: "d", typename: "DiscountAutomaticBasic", percentage: null, amount: null, amountOnEachItem: false, minSubtotal: null,
  combinesWithProduct: false, combinesWithOrder: false, ...o,
});

describe("profitFloor", () => {
  it("stays profitable at list price after the card fees (no discount assumed since 2026-10-28)", () => {
    for (const cost of [5, 19.9, 74.17, 167.95, 750.34, 2400]) {
      const p = profitFloor(cost);
      expect(netProfit(p, cost, FLOOR_DISCOUNT)).toBeGreaterThan(0);
      expect(Math.round((p % 1) * 100)).toBe(99);
    }
  });
  it("is NaN without a cost", () => {
    expect(profitFloor(null)).toBeNaN();
    expect(profitFloor(0)).toBeNaN();
    expect(profitFloor(NaN)).toBeNaN();
  });
  it("rounds up to .99", () => {
    expect(roundUpTo99(86.9)).toBe(86.99);
    expect(roundUpTo99(86.995)).toBe(87.99);
    expect(roundUpTo99(87)).toBe(87.99);
  });
});

describe("computeSellPrice never sells at a loss (2026-10-18 cases)", () => {
  it("beats the +15 % cap over a frozen Aosom price", () => {
    // commode: Aosom 144.99, cost 167.95 → was sold 144.99 (below cost)
    const r = computeSellPrice({ aosomPrice: 144.99, cost: 167.95, productType: "Home Furnishings" });
    expect(r.reason).toBe("profit");
    expect(r.price).toBe(profitFloor(167.95));
    expect(netProfit(r.price, 167.95)).toBeGreaterThan(0);
  });
  it("beats the outdoor +7 % cap", () => {
    const r = computeSellPrice({ aosomPrice: 58.99, cost: 74.17, productType: "Patio & Garden > Greenhouses" });
    expect(r.reason).toBe("profit");
    expect(netProfit(r.price, 74.17)).toBeGreaterThan(0);
  });
  it("beats a cheaper competitor", () => {
    const r = computeSellPrice({ aosomPrice: 700, cost: 750.34, competitorPrice: 770 });
    expect(r.reason).toBe("profit");
    expect(netProfit(r.price, 750.34)).toBeGreaterThan(0);
  });
  it("leaves a profitable price alone", () => {
    const r = computeSellPrice({ aosomPrice: 100, cost: 70, productType: "Home Furnishings" });
    expect(r.reason).not.toBe("profit");
  });
});

describe("planSellPrices applies the profit floor", () => {
  it("raises a stored price under the floor, even without competitor data and under a discount cap", () => {
    const plan = planSellPrices(
      [{ sku: "A", aosomPrice: 144.99, productType: "Home Furnishings", sellPrice: 144.99, cost: 167.95, maxPrice: 150 }],
      null,
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].to).toBe(profitFloor(167.95));
    expect(plan.changes[0].reason).toBe("profit");
  });
  it("brings a profitable but raised stored price back to the Aosom price (2026-10-28)", () => {
    const plan = planSellPrices([{ sku: "B", aosomPrice: 100, productType: "Home Furnishings", sellPrice: 124.99, cost: 70 }], null);
    expect(plan.changes).toEqual([expect.objectContaining({ sku: "B", from: 124.99, to: 100, reason: "floor" })]);
  });
});

describe("margin guard: discounts", () => {
  it("bounds today's three discounts at 10 %", () => {
    const r = evaluateDiscounts([
      disc({ title: "2e article", typename: "DiscountAutomaticBxgy", percentage: 0.1 }),
      disc({ title: "BIENVENUE20", typename: "DiscountCodeBasic", amount: 20, minSubtotal: 200 }),
      disc({ title: "Serge", percentage: 0.1 }),
    ]);
    expect(r.problems).toEqual([]);
    expect(r.worst).toBeCloseTo(0.1);
  });
  it("flags a discount above 10 %", () => {
    expect(evaluateDiscounts([disc({ title: "SOLDE25", percentage: 0.25 })]).problems[0]).toMatch(/SOLDE25/);
  });
  it("flags discounts that stack", () => {
    const r = evaluateDiscounts([disc({ title: "a", percentage: 0.1, combinesWithOrder: true }), disc({ title: "b", amount: 20, minSubtotal: 200, combinesWithProduct: true })]);
    expect(r.problems.join(" ")).toMatch(/cumuler/);
    expect(r.worst).toBeCloseTo(0.2);
  });
  it("flags what cannot be bounded", () => {
    expect(maxPerItem(disc({ amount: 20 }))).toBeNull();
    expect(maxPerItem(disc({ amount: 5, amountOnEachItem: true, minSubtotal: 100 }))).toBeNull();
    expect(maxPerItem(disc({ typename: "DiscountCodeApp" }))).toBeNull();
    expect(maxPerItem(disc({ typename: "DiscountCodeFreeShipping" }))).toBe(0);
  });
  it("reads a BXGY value from its effect", () => {
    const i = toDiscountInfo({ __typename: "DiscountAutomaticBxgy", title: "x", customerGets: { value: { __typename: "DiscountOnQuantity", effect: { __typename: "DiscountPercentage", percentage: 0.1 } } } });
    expect(i.percentage).toBe(0.1);
  });
});

describe("margin guard: prices", () => {
  it("flags only variants that lose money with the discount and fees", () => {
    const costs = new Map([["L", 167.95], ["OK", 70]]);
    const r = findLosses(
      [
        { sku: "L", handle: "commode", price: 144.99, source: "aosom" },
        { sku: "OK", handle: "ok", price: 100, source: "aosom" },
        { sku: "N", handle: "nocost", price: 50, source: "aosom" },
      ],
      costs,
      0.1,
    );
    expect(r.losses.map((l) => l.sku)).toEqual(["L"]);
    expect(r.withoutCost).toBe(1);
  });
});
