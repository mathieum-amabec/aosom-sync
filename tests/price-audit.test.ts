import { describe, it, expect } from "vitest";
import { computePriceFloorViolations } from "@/lib/price-audit";

const aosom = (entries: [string, number][]) => new Map<string, number>(entries);

describe("computePriceFloorViolations", () => {
  it("flags variants priced strictly below the Aosom floor, worst gap first", () => {
    const floor = aosom([["A", 100], ["B", 50], ["C", 200]]);
    const variants = [
      { sku: "A", price: 90 },   // below by 10
      { sku: "B", price: 49.5 }, // below by 0.50
      { sku: "C", price: 250 },  // above floor → ok
    ];
    const r = computePriceFloorViolations(floor, variants);
    expect(r.total).toBe(3);
    expect(r.below_floor).toBe(2);
    expect(r.items.map((i) => i.sku)).toEqual(["A", "B"]); // -10 sorts before -0.50
    expect(r.items[0]).toEqual({ sku: "A", shopify_price: 90, aosom_price: 100, gap: -10 });
    expect(r.items[1].gap).toBe(-0.5);
  });

  it("treats an exact-match price as at-floor, NOT below (force-pushed normal state)", () => {
    const r = computePriceFloorViolations(aosom([["A", 100]]), [{ sku: "A", price: 100 }]);
    expect(r.total).toBe(1);
    expect(r.below_floor).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("rounds to cents so float noise on equal prices is not a violation", () => {
    // 19.99 stored as a float can compare just under; rounding to cents keeps it at-floor.
    const r = computePriceFloorViolations(aosom([["A", 19.99]]), [{ sku: "A", price: 0.07 + 19.92 }]);
    expect(r.below_floor).toBe(0);
  });

  it("ignores SKUs not present in the Aosom catalog, blank SKUs, and zero/negative floors", () => {
    const floor = aosom([["A", 100], ["Z", 0]]);
    const variants = [
      { sku: "GHOST", price: 1 }, // not in catalog → skipped
      { sku: "", price: 1 },      // blank sku → skipped
      { sku: "Z", price: 1 },     // floor 0 → not auditable → skipped
      { sku: "A", price: 99 },    // below → counted
    ];
    const r = computePriceFloorViolations(floor, variants);
    expect(r.total).toBe(1);
    expect(r.below_floor).toBe(1);
    expect(r.items[0].sku).toBe("A");
  });

  it("counts each SKU once even if Shopify returns a duplicate variant", () => {
    const r = computePriceFloorViolations(aosom([["A", 100]]), [
      { sku: "A", price: 80 },
      { sku: "A", price: 70 }, // duplicate sku → ignored
    ]);
    expect(r.total).toBe(1);
    expect(r.below_floor).toBe(1);
    expect(r.items[0].shopify_price).toBe(80); // first wins
  });

  it("is empty when there is nothing to compare", () => {
    expect(computePriceFloorViolations(aosom([]), [])).toEqual({ total: 0, below_floor: 0, items: [] });
  });
});
