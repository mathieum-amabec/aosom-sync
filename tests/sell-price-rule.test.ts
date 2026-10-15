import { describe, it, expect } from "vitest";
import {
  computeSellPrice,
  roundDownTo99,
  tierMarkup,
  MAX_MARKUP,
  UNDERCUT_DOLLARS,
} from "@/lib/sell-price-rule";

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

describe("tierMarkup (no competitor price)", () => {
  it("carries more on small and mid items and less on big tickets (7/7/6/5/3 %)", () => {
    expect(tierMarkup(49.99)).toBe(0.07);
    expect(tierMarkup(99.99)).toBe(0.07);
    expect(tierMarkup(100)).toBe(0.07);
    expect(tierMarkup(199.99)).toBe(0.07);
    expect(tierMarkup(200)).toBe(0.06);
    expect(tierMarkup(399.99)).toBe(0.06);
    expect(tierMarkup(400)).toBe(0.05);
    expect(tierMarkup(799.99)).toBe(0.05);
    expect(tierMarkup(800)).toBe(0.03);
    expect(tierMarkup(2000)).toBe(0.03);
  });
  it("applies no markup to patio / outdoor / garden, whatever the price", () => {
    expect(tierMarkup(120, "Patio & Garden > Sun Loungers")).toBe(0);
    expect(tierMarkup(60, "Outdoor & Patio")).toBe(0);
    expect(tierMarkup(60, "Home Furnishings")).toBe(0.07);
  });
});

describe("computeSellPrice", () => {
  it("never goes below the Aosom price", () => {
    for (const aosom of [19.99, 89.99, 239.99, 744.99, 1699.99]) {
      for (const comp of [undefined, null, aosom * 0.6, aosom, aosom * 1.2]) {
        const r = computeSellPrice({ aosomPrice: aosom, competitorPrice: comp });
        expect(r.price).toBeGreaterThanOrEqual(aosom);
      }
    }
  });

  it("undercuts the competitor by a dollar when they are above us", () => {
    // Aosom 239.99, competitor 258.99: want 257.99 (inside the +15% cap of 275.98)
    const r = computeSellPrice({ aosomPrice: 239.99, competitorPrice: 258.99 });
    expect(r.price).toBe(257.99);
    expect(r.reason).toBe("competitor");
    expect(UNDERCUT_DOLLARS).toBe(1);
  });

  it("stays strictly below the competitor whenever we sit above the floor", () => {
    for (const [aosom, comp] of [[239.99, 258.99], [77.99, 87.99], [436.99, 474.99], [329.99, 423.99]] as const) {
      const r = computeSellPrice({ aosomPrice: aosom, competitorPrice: comp });
      if (r.price > aosom) expect(r.price).toBeLessThan(comp);
    }
  });

  it("caps the markup at +15% even if the competitor is far above", () => {
    // Aosom 329.99, competitor 423.99 (+28%): cap = 379.4885 -> rounded down 378.99
    const r = computeSellPrice({ aosomPrice: 329.99, competitorPrice: 423.99 });
    expect(r.price).toBe(378.99);
    expect(r.reason).toBe("cap");
    expect(r.price).toBeLessThanOrEqual(329.99 * (1 + MAX_MARKUP));
  });

  it("sits at the Aosom floor when the competitor is at or below it (we cannot go lower)", () => {
    expect(computeSellPrice({ aosomPrice: 144.99, competitorPrice: 133.99 })).toMatchObject({ price: 144.99, reason: "floor" });
    expect(computeSellPrice({ aosomPrice: 100.99, competitorPrice: 100.99 })).toMatchObject({ price: 100.99, reason: "floor" });
  });

  it("ignores an implausible competitor price (different pack / bad scrape) and falls back to the tiers", () => {
    const tooHigh = computeSellPrice({ aosomPrice: 100.99, competitorPrice: 400 });
    expect(tooHigh.competitorIgnored).toBe(true);
    expect(tooHigh.reason).toBe("tier");
    expect(tooHigh.price).toBe(107.99); // 100.99 * 1.07 = 108.06 -> rounded down to .99
    const tooLow = computeSellPrice({ aosomPrice: 100.99, competitorPrice: 20 });
    expect(tooLow.competitorIgnored).toBe(true);
    expect(tooLow.price).toBeGreaterThanOrEqual(100.99);
  });

  it("uses the tiers when no competitor price exists", () => {
    // 60.99 * 1.07 = 65.26 -> 64.99 (rounded down to .99)
    const r = computeSellPrice({ aosomPrice: 60.99 });
    expect(r.reason).toBe("tier");
    expect(r.price).toBe(64.99);
    // 1500.99 * 1.03 = 1546.02 -> 1545.99
    expect(computeSellPrice({ aosomPrice: 1500.99 })).toMatchObject({ price: 1545.99, reason: "tier" });
  });

  it("returns NaN for a missing or invalid Aosom price so callers skip (never push $0)", () => {
    expect(computeSellPrice({ aosomPrice: 0 }).price).toBeNaN();
    expect(computeSellPrice({ aosomPrice: -5 }).price).toBeNaN();
    expect(computeSellPrice({ aosomPrice: NaN }).price).toBeNaN();
  });

  it("keeps a floor that does not end in .99 untouched", () => {
    const r = computeSellPrice({ aosomPrice: 4.14, competitorPrice: undefined });
    expect(r.price).toBeGreaterThanOrEqual(4.14);
  });
});
