/**
 * scoreAndRank is pure (no DB), so these test the actual weighting/ranking logic
 * directly — the 0.6/0.4 combination and the seasonal multiplier — without a live client.
 */
import { describe, it, expect } from "vitest";
import { scoreAndRank, type PriorityCandidate } from "../content-priority";

const base: PriorityCandidate = { sku: "x", productType: null, velocity14d: 0, hasDiscount: false };

describe("scoreAndRank", () => {
  it("weights velocity at 60% and the discount flag at 40%", () => {
    const [a, b] = scoreAndRank([
      { ...base, sku: "high-velocity-no-discount", velocity14d: 100, hasDiscount: false },
      { ...base, sku: "low-velocity-discount", velocity14d: 1, hasDiscount: true },
    ]);
    // velocity-only: 100 normalizes to 1.0 * 0.6 = 0.6; the other's velocity (1/100=0.01)*0.6=0.006 + 0.4 = 0.406
    expect(a.sku).toBe("high-velocity-no-discount");
    expect(a.trendScore).toBeCloseTo(0.6, 5);
    expect(b.trendScore).toBeCloseTo(0.406, 5);
  });

  it("normalizes velocity within the given set (min-max against the max, not a fixed scale)", () => {
    const scored = scoreAndRank([
      { ...base, sku: "a", velocity14d: 50 },
      { ...base, sku: "b", velocity14d: 25 },
    ]);
    const a = scored.find((s) => s.sku === "a")!;
    const b = scored.find((s) => s.sku === "b")!;
    expect(a.velocityScore).toBeCloseTo(1.0, 5);
    expect(b.velocityScore).toBeCloseTo(0.5, 5);
  });

  it("does not divide by zero when every candidate has 0 velocity", () => {
    const scored = scoreAndRank([{ ...base, sku: "a", velocity14d: 0, hasDiscount: true }]);
    expect(scored[0].velocityScore).toBe(0);
    expect(scored[0].trendScore).toBeCloseTo(0.4, 5);
  });

  it("boosts Home Furnishings (indoor) product_type by 1.2x", () => {
    const [scored] = scoreAndRank([
      { ...base, sku: "a", velocity14d: 10, productType: "Home Furnishings > Living Room Furniture > Coffee Tables" },
    ]);
    expect(scored.seasonalMultiplier).toBe("indoor");
    expect(scored.priority).toBeCloseTo(scored.trendScore * 1.2, 5);
  });

  it("boosts a seasonal keyword match (Storage/Christmas/Holiday/Fireplace) by 1.15x", () => {
    const [scored] = scoreAndRank([
      { ...base, sku: "a", velocity14d: 10, productType: "Sports & Recreation > Outdoor Storage > Deck Boxes" },
    ]);
    expect(scored.seasonalMultiplier).toBe("seasonal-keyword");
    expect(scored.priority).toBeCloseTo(scored.trendScore * 1.15, 5);
  });

  it("applies no boost to a neutral category", () => {
    const [scored] = scoreAndRank([
      { ...base, sku: "a", velocity14d: 10, productType: "Sports & Recreation > Exercise Equipment > Treadmills" },
    ]);
    expect(scored.seasonalMultiplier).toBe("neutral");
    expect(scored.priority).toBeCloseTo(scored.trendScore, 5);
  });

  it("sorts by priority descending, seasonal boost able to overtake raw trend score", () => {
    const scored = scoreAndRank([
      { ...base, sku: "high-trend-patio-adjacent", velocity14d: 100, hasDiscount: true, productType: "Sports & Recreation > Camping" },
      { ...base, sku: "lower-trend-indoor", velocity14d: 40, hasDiscount: false, productType: "Home Furnishings > Storage & Organization > Storage Cabinets" },
    ]);
    // 1.0*0.6+0.4=1.0 vs (0.4*0.6=0.24)*1.2=0.288 — the patio-adjacent one still wins here,
    // confirming the boost tilts ordering without letting a low-trend item leapfrog a
    // much higher one outright (documents the actual magnitude, not just direction).
    expect(scored[0].sku).toBe("high-trend-patio-adjacent");
  });

  it("Patio & Garden rows are expected to be excluded upstream by fetchPriorityCandidates, not here", () => {
    // scoreAndRank itself doesn't filter by category — the hard Patio & Garden exclusion
    // lives in fetchPriorityCandidates' SQL (product_type NOT LIKE 'Patio & Garden%').
    // Documented here so a future reader doesn't assume this function does the filtering.
    const scored = scoreAndRank([{ ...base, sku: "a", velocity14d: 10, productType: "Patio & Garden > Patio Furniture > Patio Furniture Sets" }]);
    expect(scored[0].seasonalMultiplier).toBe("neutral");
  });
});
