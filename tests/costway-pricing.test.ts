import { describe, it, expect, afterEach } from "vitest";
import { charm99, costOf, costwaySellPrice, marginOf, sellableQty, dropshipDiscount, targetMargin } from "@/lib/costway/pricing";

afterEach(() => { delete process.env.COSTWAY_DROPSHIP_DISCOUNT; delete process.env.COSTWAY_TARGET_MARGIN; });

describe("costwaySellPrice", () => {
  it("sells at Costway's price, rounded up to x.99 (2026-10-29)", () => {
    expect(targetMargin()).toBe(0);
    expect(costwaySellPrice({ price: 239.99, priceDrop: null, promoTag: "" })).toBe(239.99);
    expect(costwaySellPrice({ price: 69, priceDrop: null, promoTag: "Clearance" })).toBe(69.99);
    expect(marginOf(239.99, 239.99).pct).toBe(16);
  });
  it("uses the same rule on a Drop Price item (uniform prices)", () => {
    expect(costwaySellPrice({ price: 479.99, priceDrop: null, promoTag: "Drop Price" })).toBe(479.99);
  });
  it("COSTWAY_TARGET_MARGIN puts a markup back", () => {
    process.env.COSTWAY_TARGET_MARGIN = "0.23";
    expect(costwaySellPrice({ price: 239.99, priceDrop: null, promoTag: "" })).toBe(261.99);
  });
  it("never goes below Costway's price nor its Price Drop floor", () => {
    expect(costwaySellPrice({ price: 100, priceDrop: 130, promoTag: "Drop Price" })).toBe(130.99);
    process.env.COSTWAY_TARGET_MARGIN = "0.01";
    expect(costwaySellPrice({ price: 100, priceDrop: null, promoTag: "" })).toBe(100.99);
  });
  it("charm99 gives the smallest x.99 at or above the price", () => {
    expect(charm99(109.09)).toBe(109.99);
    expect(charm99(109.99)).toBe(109.99);
    expect(charm99(110)).toBe(110.99);
  });
  it("returns NaN for an unusable price instead of $0", () => {
    expect(costwaySellPrice({ price: 0, priceDrop: null, promoTag: "" })).toBeNaN();
    expect(costwaySellPrice({ price: Number.NaN, priceDrop: null, promoTag: "" })).toBeNaN();
  });
});

describe("cost and margin", () => {
  it("cost is the feed price less the 16% dropship discount", () => {
    expect(dropshipDiscount()).toBe(0.16);
    expect(costOf(100)).toBe(84);
  });
  it("margin at Costway's own price would be 16%; 3 % under it, ~13.4%", () => {
    expect(marginOf(100, 100)).toEqual({ dollars: 16, pct: 16 });
    expect(marginOf(97, 100)).toEqual({ dollars: 13, pct: 13.4 });
  });
  it("COSTWAY_DROPSHIP_DISCOUNT overrides, ignoring nonsense", () => {
    process.env.COSTWAY_DROPSHIP_DISCOUNT = "0.2";
    expect(costOf(100)).toBe(80);
    process.env.COSTWAY_DROPSHIP_DISCOUNT = "5";
    expect(dropshipDiscount()).toBe(0.16);
  });
});

describe("sellableQty", () => {
  it("is sold out under the minimum and capped above", () => {
    expect(sellableQty(2)).toBe(0);
    expect(sellableQty(3)).toBe(3);
    expect(sellableQty(1972)).toBe(50);
    expect(sellableQty(Number.NaN)).toBe(0);
  });
});
