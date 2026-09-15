import { describe, it, expect } from "vitest";
import {
  SUPPLIER_BRANDS,
  stripSupplierBrands,
  forbiddenBrandsIn,
  detectDescriptionLanguage,
} from "@/lib/catalog-guard";

describe("stripSupplierBrands", () => {
  it("removes a plain space-separated brand mention", () => {
    expect(stripSupplierBrands("Ce canapé Outsunny est confortable.")).toBe(
      "Ce canapé est confortable.",
    );
  });

  it("removes a brand elided directly onto it (l'Aosom, d'Aosom) without leaving a dangling apostrophe", () => {
    expect(stripSupplierBrands("Démarrez l'aventure avec l'Aosom Audi RS e-tron GT.")).toBe(
      "Démarrez l'aventure avec Audi RS e-tron GT.",
    );
    expect(stripSupplierBrands("cette magnifique maison d'extérieur 2 étages d'Aosom.")).toBe(
      "cette magnifique maison d'extérieur 2 étages.",
    );
    expect(stripSupplierBrands("Ce sofa pour chien et chat d'Aosom offre un beau design.")).toBe(
      "Ce sofa pour chien et chat offre un beau design.",
    );
  });

  it("is case-insensitive and covers every canonical brand", () => {
    for (const brand of SUPPLIER_BRANDS) {
      const out = stripSupplierBrands(`Produit ${brand.toUpperCase()} de qualité.`);
      expect(out.toLowerCase()).not.toContain(brand.toLowerCase());
    }
  });

  it("does not touch a brand name fused into a larger word", () => {
    expect(stripSupplierBrands("qabardine")).toBe("qabardine");
  });

  it("leaves brand-free text untouched", () => {
    expect(stripSupplierBrands("Une chaise confortable pour le jardin.")).toBe(
      "Une chaise confortable pour le jardin.",
    );
  });

  it("collapses whitespace left behind by multiple removals", () => {
    expect(stripSupplierBrands("Qaba Soozier tapis de jardin")).toBe("tapis de jardin");
  });
});

describe("forbiddenBrandsIn", () => {
  it("lists every distinct forbidden brand found, lowercased and deduped", () => {
    const html = "<p>Ce produit Outsunny et cet autre outsunny, mais aussi HOMCOM.</p>";
    expect(forbiddenBrandsIn(html).sort()).toEqual(["homcom", "outsunny"]);
  });

  it("returns an empty array for clean content", () => {
    expect(forbiddenBrandsIn("<p>Une chaise confortable.</p>")).toEqual([]);
  });

  it("handles null/undefined input safely", () => {
    expect(forbiddenBrandsIn(null)).toEqual([]);
    expect(forbiddenBrandsIn(undefined)).toEqual([]);
  });
});

describe("detectDescriptionLanguage", () => {
  it("detects French from common function words", () => {
    const html = "<p>Cette chaise est parfaite pour votre jardin, avec des accoudoirs confortables.</p>";
    expect(detectDescriptionLanguage(html).lang).toBe("FR");
  });

  it("detects English from common function words", () => {
    const html = "<p>This chair is great for your garden and easy to clean with the included cover.</p>";
    expect(detectDescriptionLanguage(html).lang).toBe("EN");
  });

  it("classifies genuinely empty/undetectable content as empty", () => {
    expect(detectDescriptionLanguage("").lang).toBe("empty");
    expect(detectDescriptionLanguage(null).lang).toBe("empty");
    expect(detectDescriptionLanguage("<p></p>").lang).toBe("empty");
  });

  it("classifies a near-balanced mix as MIXED", () => {
    // Real intra-text mixing is rare in production (0/1347 measured 2026-09-15), but
    // the detector must not silently call a genuine 50/50 mix "FR" or "EN".
    const html = "<p>Cette chaise is great pour votre jardin and easy to clean avec un chiffon doux for daily use.</p>";
    expect(detectDescriptionLanguage(html).lang).toBe("MIXED");
  });

  it("strips HTML tags before counting words", () => {
    const html = "<div><ul><li>Pour</li><li>votre</li><li>jardin</li></ul></div>";
    const result = detectDescriptionLanguage(html);
    expect(result.fr).toBeGreaterThan(0);
    expect(result.lang).toBe("FR");
  });
});
