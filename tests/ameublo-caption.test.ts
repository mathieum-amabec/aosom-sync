import { describe, it, expect } from "vitest";
import { ameubloCaption, productUrl, type AmeubloStyle } from "@/lib/ameublo-caption";

const base = { titles: ["Sofa 3 places", "Table basse", "Lampe", "Tapis"], prices: [100, 50, 25.5, 80], handles: ["sofa-3", "t", "l", "r"] };

describe("ameubloCaption", () => {
  const styles: AmeubloStyle[] = ["reaction", "vitrine", "astuce", "devine", "ab", "top3", "piece"];
  it("never mentions a supplier and always carries shipping + a link, in both languages", () => {
    for (const lang of ["fr", "en"] as const) for (const style of styles) {
      const c = ameubloCaption({ ...base, style, lang, cap: 120, room: "salon" });
      expect(c).not.toMatch(/aosom|homcom|outsunny/i);
      expect(c).toMatch(lang === "fr" ? /Livraison gratuite/ : /Free shipping/);
      expect(c).toMatch(lang === "fr" ? /ameublodirect\.ca/ : /furnishdirect\.ca/);
    }
  });
  it("links single-product styles to the product", () => {
    expect(ameubloCaption({ ...base, style: "vitrine", lang: "fr" })).toContain("https://ameublodirect.ca/products/sofa-3");
    expect(productUrl(null, "en")).toBe("https://furnishdirect.ca");
  });
  it("sums the room total and uses CAD formatting per language", () => {
    expect(ameubloCaption({ ...base, style: "piece", lang: "en" })).toContain("$255.50 total");
  });
  it("rotates wording with the variant", () => {
    const a = ameubloCaption({ ...base, style: "vitrine", lang: "fr", variant: 0 });
    const b = ameubloCaption({ ...base, style: "vitrine", lang: "fr", variant: 1 });
    expect(a).not.toBe(b);
  });
  it("promo Réaction never claims anyone reacted, and never says « meuble »", () => {
    for (const lang of ["fr", "en"] as const) for (let variant = 0; variant < 3; variant++) {
      const c = ameubloCaption({ ...base, style: "reaction", lang, variant, promo: true });
      expect(c).not.toMatch(/adoré|loved|leur réaction|that reaction|meuble/i);
      expect(ameubloCaption({ ...base, style: "reaction", lang, variant })).not.toMatch(/meuble/i);
    }
  });
});
