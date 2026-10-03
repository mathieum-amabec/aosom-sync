import { describe, it, expect } from "vitest";
import { wrap, tipFor, DEFAULT_TIP, priceFr, prog, easeOutBack } from "@/lib/video-engines/ameublo-scenes";

describe("ameublo-scenes helpers", () => {
  it("wraps on word boundaries and caps the line count with an ellipsis", () => {
    expect(wrap("PLACEZ LE HAUT DE VOTRE ÉCRAN", 12)).toEqual(["PLACEZ LE", "HAUT DE", "VOTRE ÉCRAN"]);
    const capped = wrap("UN DEUX TROIS QUATRE CINQ SIX SEPT", 6, 2);
    expect(capped).toHaveLength(2);
    expect(capped[1].endsWith("…")).toBe(true);
  });

  it("picks a tip by product family, with a safe default", () => {
    expect(tipFor("Home Furnishings > Sofas > 2-Seater Sofas Loveseat")).toMatch(/sofa/i);
    expect(tipFor("Office Desks Computer Desk")).toMatch(/écran/i);
    expect(tipFor("Pre Lit Christmas Trees")).toMatch(/sapin/i);
    expect(tipFor("Garden Hose")).toBe(DEFAULT_TIP);
  });

  it("formats prices the Quebec way", () => {
    expect(priceFr(182.99)).toBe("182,99 $");
  });

  it("clamps progress and overshoots then settles with easeOutBack", () => {
    expect(prog(0, 1, 1)).toBe(0);
    expect(prog(5, 1, 1)).toBe(1);
    expect(easeOutBack(1)).toBeCloseTo(1);
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1);
  });
});
