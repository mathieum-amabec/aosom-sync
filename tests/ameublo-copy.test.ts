import { describe, it, expect } from "vitest";
import { ameubloLines, productFamily, HOOKS, VALUE } from "@/lib/ameublo-copy";
import { decoyPrice, top3Cap, roomTotal } from "@/lib/video-engines/ameublo-scenes";

describe("ameublo-copy", () => {
  it("maps product types to families", () => {
    expect(productFamily("Pet Supplies > Dogs > Dog Bike Trailers")).toBe("animaux");
    expect(productFamily("Toys & Games > Electric Ride-On Toys")).toBe("enfants");
    expect(productFamily("Living Room Furniture > Sofas > 2-Seater Sofas")).toBe("salon");
    expect(productFamily("Storage & Organization > Kitchen Pantry Cabinets")).toBe("rangement");
    expect(productFamily("Garden Hose")).toBe("general");
  });

  it("is deterministic per SKU and draws from the banks", () => {
    const a = ameubloLines("838-212WT", "Kitchen Pantry Cabinets");
    expect(ameubloLines("838-212WT", "Kitchen Pantry Cabinets")).toEqual(a);
    expect(HOOKS).toContain(a.hook);
    expect(VALUE.rangement.concat(VALUE.cuisine)).toContain(a.value);
  });

  it("varies the hook from one video of a series to the next", () => {
    const hooks = [0, 1, 2, 3].map((v) => ameubloLines("838-212WT", "x", v).hook);
    expect(new Set(hooks).size).toBe(4);
  });
});

describe("honest numbers in the new styles", () => {
  it("decoy price is clearly different from the real one and ends in .99", () => {
    for (const sku of ["839-622V00CW", "370-150RD", "A", "BB"]) {
      const d = decoyPrice(268.99, sku);
      expect(Math.abs(d - 268.99)).toBeGreaterThan(100);
      expect(d.toFixed(2).endsWith(".99")).toBe(true);
    }
  });

  it("Top 3 cap is at or above every price shown", () => {
    expect(top3Cap([102.99, 107.99, 114.99])).toBe(120);
    expect(top3Cap([164.99, 116.99, 114.99])).toBe(170);
    expect(top3Cap([120])).toBe(120);
  });

  it("room total is the exact sum of the prices, to the cent", () => {
    expect(roomTotal([268.99, 114.99, 107.99, 102.99])).toBe(594.96);
    expect(roomTotal([0.1, 0.2])).toBe(0.3);
  });
});
