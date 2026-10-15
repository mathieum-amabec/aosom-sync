import { describe, it, expect } from "vitest";
import { displayedPriceSource, planCompareAt, referencePrice, type PriceSource, type SellStep } from "@/lib/compare-at";

const DAY = 86_400;
const NOW = 1_800_000_000;
const ago = (days: number) => NOW - days * DAY;

describe("displayedPriceSource", () => {
  const aosom: PriceSource = { dbPrice: 100, steps: [], firstSeenAt: ago(60) };

  it("keeps the Aosom price as the expected price while no sell price is set", () => {
    expect(displayedPriceSource(aosom, null, []).dbPrice).toBe(100);
  });

  it("expects the sell price on Shopify once one is set (no false drift for a marked-up variant)", () => {
    expect(displayedPriceSource(aosom, 107, []).dbPrice).toBe(107);
  });

  it("falls back to the Aosom price when the stored sell price is below it", () => {
    expect(displayedPriceSource(aosom, 90, []).dbPrice).toBe(100);
  });

  it("a markup is not a price the customer once paid: no crossed price after a +7 % rollout", () => {
    const sells: SellStep[] = [{ oldPrice: null, newPrice: 107, aosomPrice: 100, at: ago(20) }];
    const src = displayedPriceSource(aosom, 107, sells);
    expect(referencePrice(src.dbPrice, src.steps, src.firstSeenAt, NOW)).toBeNull();
  });

  it("uses our own history: a real drop from a held markup shows the held price", () => {
    const sells: SellStep[] = [
      { oldPrice: null, newPrice: 107, aosomPrice: 100, at: ago(40) }, // held 107 for 20 days
      { oldPrice: 107, newPrice: 90, aosomPrice: 84, at: ago(20) }, // Aosom drops, so do we
    ];
    const src = displayedPriceSource({ ...aosom, dbPrice: 84 }, 90, sells);
    expect(src.dbPrice).toBe(90);
    expect(referencePrice(src.dbPrice, src.steps, src.firstSeenAt, NOW)).toBe(107);
  });

  it("keeps the Aosom steps that happened before our first sell price", () => {
    const withSteps: PriceSource = { dbPrice: 100, firstSeenAt: ago(80), steps: [{ oldPrice: 130, newPrice: 100, at: ago(50) }] };
    const sells: SellStep[] = [{ oldPrice: null, newPrice: 107, aosomPrice: 100, at: ago(2) }];
    const src = displayedPriceSource(withSteps, 107, sells);
    expect(src.steps[0]).toEqual({ oldPrice: 130, newPrice: 100, at: ago(50) });
    expect(src.steps).toHaveLength(2);
  });

  it("a marked-up variant is no longer skipped as drift by the plan", () => {
    const src = displayedPriceSource(aosom, 107, [{ oldPrice: null, newPrice: 107, aosomPrice: 100, at: ago(3) }]);
    const plan = planCompareAt([{ sku: "A", variantId: "v1", price: 107, compareAtPrice: null }], new Map([["A", src]]), NOW);
    expect(plan.skippedDrift).toBe(0);
  });
});
