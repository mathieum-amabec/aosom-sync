import { describe, it, expect } from "vitest";
import { buildCandidates, MIN_IMPORT_MARGIN, MARGIN_RULES_MIN_COSTS } from "@/lib/auto-import/policy";
import type { AosomMergedProduct, AosomVariant } from "@/types/aosom";

const NOW = new Date("2026-10-15T12:00:00Z");

function variant(sku: string, price: number): AosomVariant {
  return {
    sku, price, qty: 50, color: "", size: "", gtin: "", weight: 5, dimensions: { length: 1, width: 1, height: 1 },
    images: [], estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "",
  };
}
function group(key: string, price: number, type = "Home Furnishings > Living Room"): AosomMergedProduct {
  return {
    groupKey: key, name: `Produit ${key}`, brand: "x", productType: type, category: "", description: "d", shortDescription: "",
    material: "", images: ["a", "b", "c", "d"], video: "", pdf: "", variants: [variant(`${key}-A`, price)],
  };
}
/** A cost map big enough for the margin rules to apply (MARGIN_RULES_MIN_COSTS), plus the entries under test. */
function costs(entries: Record<string, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < MARGIN_RULES_MIN_COSTS; i++) m.set(`FILLER-${i}`, 10);
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}
const ctx = (extra: Partial<Parameters<typeof buildCandidates>[1]> = {}) => ({
  importedSkus: new Set<string>(), firstSeen: new Map<string, number>(), jobs: new Map(), now: NOW, ...extra,
});

describe("import pricing rules", () => {
  it("keeps a product whose price rule leaves a healthy margin and records it", () => {
    // Aosom 100, cost 86: 20 % margin price is 106.99 -> margin ~19.6 %
    const out = buildCandidates([group("ok", 100)], ctx({ costs: costs({ "ok-A": 86 }) }));
    expect(out.candidates.map((c) => c.groupKey)).toEqual(["ok"]);
    expect(out.candidates[0].margin).toBeGreaterThan(0.19);
    expect(out.candidates[0].marginDollars).toBeGreaterThan(20);
    expect(out.rejected).toEqual({ noCost: 0, lowMargin: 0, lowDemand: 0 });
  });

  it("rejects a product with no known cost", () => {
    const out = buildCandidates([group("nocost", 100)], ctx({ costs: costs({}) }));
    expect(out.candidates).toHaveLength(0);
    expect(out.rejected.noCost).toBe(1);
  });

  it("rejects a product whose margin stays under the minimum even at the rule's price", () => {
    // cost 98 on a 100 price: even +15 % (114.99) gives 14.8 %... use cost 105 -> under water at 114.99? margin 8.7 %
    const out = buildCandidates([group("thin", 100)], ctx({ costs: costs({ "thin-A": 105 }) }));
    expect(out.candidates).toHaveLength(0);
    expect(out.rejected.lowMargin).toBe(1);
  });

  it("a competitor a dollar-under price can make a product too thin to import", () => {
    // cost 90, competitor 100 -> price 98.99, margin 9.1 % < 12 %
    const out = buildCandidates([group("squeezed", 100)], ctx({ costs: costs({ "squeezed-A": 90 }), competitor: new Map([["SQUEEZED-A", 100]]) }));
    expect(out.candidates).toHaveLength(0);
    expect(out.rejected.lowMargin).toBe(1);
  });

  it("does not apply the rules when the feed gave (almost) no costs", () => {
    const out = buildCandidates([group("free", 100)], ctx({ costs: new Map([["free-A", 999]]) }));
    expect(out.candidates.map((c) => c.groupKey)).toEqual(["free"]);
    expect(out.candidates[0].margin).toBeUndefined();
  });

  it("does not apply the rules when no cost map is given (existing behaviour)", () => {
    expect(buildCandidates([group("plain", 100)], ctx()).candidates).toHaveLength(1);
  });

  it("the minimum margin is 12 %", () => {
    expect(MIN_IMPORT_MARGIN).toBe(0.12);
  });
});
