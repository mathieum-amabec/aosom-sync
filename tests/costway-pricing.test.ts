import { describe, it, expect, afterEach } from "vitest";
import { costOf, costwaySellPrice, marginOf, sellableQty, dropshipDiscount } from "@/lib/costway/pricing";

afterEach(() => { delete process.env.COSTWAY_DROPSHIP_DISCOUNT; });

describe("costwaySellPrice", () => {
  it("sells at the feed price (0% markup) by default", () => {
    expect(costwaySellPrice({ price: 239.99, priceDrop: null, promoTag: "" })).toBe(239.99);
    expect(costwaySellPrice({ price: 69, priceDrop: null, promoTag: "Clearance" })).toBe(69);
  });
  it("undercuts the feed lag by 3% on a Drop Price item", () => {
    expect(costwaySellPrice({ price: 479.99, priceDrop: null, promoTag: "Drop Price" })).toBe(465.59);
  });
  it("never goes below Costway's Price Drop floor", () => {
    expect(costwaySellPrice({ price: 239.99, priceDrop: 239, promoTag: "Drop Price" })).toBe(239);
    expect(costwaySellPrice({ price: 100, priceDrop: 100, promoTag: "Drop Price" })).toBe(100);
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
  it("margin at the feed price is 16%; on a Drop Price item it is ~13.4%", () => {
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
