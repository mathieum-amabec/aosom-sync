import { describe, it, expect } from "vitest";
import { formatVideoTitle, stripSupplierBrand } from "@/lib/video-title-utils";

describe("formatVideoTitle — strips supplier brand names (first, before anything else)", () => {
  // Slideshow style (casing preserved) so the expected output matches the catalog wording.
  it.each([
    ["Qaba Kids Seesaw", "Kids Seesaw"],
    ["Outsunny 10x12 Gazebo", "10x12 Gazebo"],
    ["HOMCOM Garbage Bin", "Garbage Bin"],
    ["Outsunny Patio Glider", "Patio Glider"],
    ["Qaba 5 in 1 Toddler Slide", "5 in 1 Toddler Slide"],
    ["Vinsetto Office Chair", "Office Chair"],
    ["PawHut Dog Crate", "Dog Crate"],
    ["Outsunny® Banana Umbrella", "Banana Umbrella"],
  ])("%s → %s", (input, expected) => {
    expect(formatVideoTitle(input, 48, { uppercase: false, aggressive: false })).toBe(expected);
  });

  it("strips the brand even in the default uppercase/aggressive mode", () => {
    expect(formatVideoTitle("Qaba Kids Seesaw")).toBe("KIDS SEESAW");
  });

  it("requires a word boundary — never truncates a real word starting with a brand", () => {
    expect(formatVideoTitle("Aosomething Cool", 48, { uppercase: false, aggressive: false })).toBe("Aosomething Cool");
  });

  it("strips a stacked brand and leaves a brandless title untouched", () => {
    expect(stripSupplierBrand("Aosom Qaba Toddler Trike")).toBe("Toddler Trike");
    expect(stripSupplierBrand("Patio Glider Chair")).toBe("Patio Glider Chair");
  });
});

describe("formatVideoTitle — documented catalogue cases", () => {
  // The 7 transformations from the spec.
  it.each([
    ["CLIMATISEUR PORTATIF 10 000 BTU", "CLIMATISEUR 10 000 BTU"],
    ["BASE DE PARASOL CARRÉE RÉSINE 9 KG", "BASE PARASOL 9 KG"],
    ["CADRE DE LIT QUEEN EN MÉTAL AVEC", "CADRE DE LIT QUEEN MÉTAL"],
    ["VENTILATEUR SUR PIED OSCILLANT", "VENTILATEUR SUR PIED"],
    ["ENSEMBLE TABLE DE BAR 3 PIÈCES", "TABLE DE BAR 3 PIÈCES"],
    ["BUFFET ENFILADE MODERNE AVEC", "BUFFET ENFILADE MODERNE"],
    ["VENTILATEUR SUR PIED OSCILLANT AVEC ÉCRAN LED", "VENTILATEUR SUR PIED"],
  ])("%s → %s", (input, expected) => {
    expect(formatVideoTitle(input)).toBe(expected);
  });

  it("works on the FULL raw title (not just the pre-truncated form)", () => {
    // The "AVEC …" suffix is dropped, then "EN MÉTAL" → "MÉTAL".
    expect(formatVideoTitle("Cadre de lit queen en métal avec tête de lit")).toBe(
      "CADRE DE LIT QUEEN MÉTAL",
    );
  });

  it("keeps 'DE' where it is part of the standard term", () => {
    expect(formatVideoTitle("CADRE DE LIT QUEEN")).toBe("CADRE DE LIT QUEEN");
    expect(formatVideoTitle("TABLE DE BAR 3 PIÈCES")).toBe("TABLE DE BAR 3 PIÈCES");
  });
});

describe("formatVideoTitle — hard rules / edge cases", () => {
  it("NEVER emits an ellipsis and strips any existing one", () => {
    const out = formatVideoTitle("CLIMATISEUR PORTATIF 10 000 BTU…");
    expect(out).toBe("CLIMATISEUR 10 000 BTU");
    expect(out).not.toContain("…");
    expect(out).not.toContain("...");
  });

  it("strips a literal '...' too", () => {
    expect(formatVideoTitle("VENTILATEUR SUR PIED OSCILLANT...")).toBe("VENTILATEUR SUR PIED");
  });

  it("upper-cases lower-case input with fr-CA accents", () => {
    expect(formatVideoTitle("buffet enfilade moderne gris")).toBe("BUFFET ENFILADE MODERNE GRIS");
  });

  it("leaves a short title unchanged (just upper-cased)", () => {
    expect(formatVideoTitle("CHAISE PLIANTE")).toBe("CHAISE PLIANTE");
  });

  it("leaves an exactly-40-char title untouched (no cut, no ellipsis)", () => {
    const t40 = "AAAAA BBBBB CCCCC DDDDD EEEEE FFFFF GGGG"; // 40 chars, no rules trigger
    expect(t40.length).toBe(40);
    expect(formatVideoTitle(t40)).toBe(t40);
  });

  it("cuts an over-length title on a word boundary, never mid-word, never an ellipsis", () => {
    const out = formatVideoTitle("JARDINIÈRE SURÉLEVÉE GALVANISÉE ACIER 120X60X30CM");
    expect(out).toBe("JARDINIÈRE SURÉLEVÉE GALVANISÉE ACIER");
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toContain("…");
    // no partial word at the end
    expect(out.endsWith("120")).toBe(false);
  });

  it("respects a custom maxChars and still cuts on a space", () => {
    const out = formatVideoTitle("VENTILATEUR TOUR TROIS VITESSES MINUTERIE", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toBe("VENTILATEUR TOUR");
  });

  it("handles empty / whitespace input", () => {
    expect(formatVideoTitle("")).toBe("");
    expect(formatVideoTitle("   ")).toBe("");
  });

  it("never re-exposes a trailing filler after the length cut", () => {
    // After cutting, the last token must not be AVEC/EN/DE/ET/POUR.
    const out = formatVideoTitle("STORE RÉTRACTABLE MANUEL POUR PATIO EXTÉRIEUR DE JARDIN", 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(["AVEC", "EN", "DE", "ET", "POUR"]).not.toContain(out.split(" ").pop());
  });
});

describe("formatVideoTitle — slideshow mode (preserve case, no catalogue cleanup)", () => {
  const slideshow = { uppercase: false, aggressive: false } as const;

  it("preserves the original mixed-case wording", () => {
    expect(formatVideoTitle("Canapé sectionnel réversible", 48, slideshow)).toBe(
      "Canapé sectionnel réversible",
    );
  });

  it("does NOT drop catalogue descriptors in non-aggressive mode", () => {
    // "PORTATIF" would be dropped in aggressive mode; here it stays.
    expect(formatVideoTitle("Climatiseur portatif 10 000 BTU", 48, slideshow)).toBe(
      "Climatiseur portatif 10 000 BTU",
    );
  });

  it("KEEPS the 'avec …' clause (only aggressive mode drops it) but strips ellipsis", () => {
    expect(formatVideoTitle("Buffet enfilade moderne avec tiroirs…", 48, slideshow)).toBe(
      "Buffet enfilade moderne avec tiroirs",
    );
  });

  it("still cuts an over-length name on a word boundary, never an ellipsis", () => {
    const long = formatVideoTitle(
      "Jardinière surélevée en acier galvanisé avec tiges renforcées 180 cm",
      48,
      slideshow,
    );
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).not.toContain("…");
    // cut lands right after "avec" → the dangling connector is stripped
    expect(long).toBe("Jardinière surélevée en acier galvanisé");
  });
});
