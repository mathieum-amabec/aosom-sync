import { describe, it, expect } from "vitest";
import { HOOKS, VALUE, TEASERS, CTAS, HOOKS_EN, VALUE_EN, TEASERS_EN, CTAS_EN, ameubloLines } from "@/lib/ameublo-copy";
import { priceFmt, cleanEnglishTitle, tidyTitle, STR, SITE, ROOM_LABEL } from "@/lib/ameublo-i18n";
import { wrap, tipFor, DEFAULT_TIP_EN, TIPS, TIPS_EN } from "@/lib/video-engines/ameublo-scenes";

const fits = (s: string) => wrap(s, 14, 2).length <= 2 && wrap(s, 14, 2).join(" ").replace(/\u00a0/g, " ") === s;

describe("ameublo-i18n", () => {
  it("formats CAD for each audience", () => {
    expect(priceFmt(84.99, "fr").replace(/\s/g, " ")).toBe("84,99 $");
    expect(priceFmt(84.99, "en")).toBe("$84.99");
  });

  it("points each language at its own storefront", () => {
    expect(SITE.fr).toBe("AMEUBLODIRECT.CA");
    expect(SITE.en).toBe("FURNISHDIRECT.CA");
    expect(STR.en.top3Hook(120)).toBe("3 FINDS UNDER $120");
    expect(Object.keys(ROOM_LABEL)).toContain("salon");
  });

  it("every bubble line of both languages fits in 2 lines of 14 characters", () => {
    const all = [...HOOKS, ...TEASERS, ...CTAS, ...HOOKS_EN, ...TEASERS_EN, ...CTAS_EN,
      ...Object.values(VALUE).flat(), ...Object.values(VALUE_EN).flat()];
    const bad = all.filter((l) => !fits(l));
    expect(bad).toEqual([]);
  });

  it("EN banks mirror the FR ones", () => {
    expect(HOOKS_EN).toHaveLength(HOOKS.length);
    expect(TEASERS_EN).toHaveLength(TEASERS.length);
    expect(CTAS_EN).toHaveLength(CTAS.length);
    expect(Object.keys(VALUE_EN).sort()).toEqual(Object.keys(VALUE).sort());
    expect(TIPS_EN).toHaveLength(TIPS.length);
  });

  it("picks English lines for lang=en, deterministically", () => {
    const a = ameubloLines("838-212WT", "Kitchen Pantry Cabinets", 0, "en");
    expect(ameubloLines("838-212WT", "Kitchen Pantry Cabinets", 0, "en")).toEqual(a);
    expect(HOOKS_EN).toContain(a.hook);
    expect(CTAS_EN).toContain(a.cta);
  });

  it("gives English tips", () => {
    expect(tipFor("2-Seater Sofas Loveseat", "en")).toMatch(/sofa/i);
    expect(tipFor("Garden Hose", "en")).toBe(DEFAULT_TIP_EN);
  });

  it("strips supplier names from English titles and keeps the head of the title", () => {
    const t = cleanEnglishTitle("HOMCOM 3-Piece Sectional Sofa Set, L-Shaped Couch with Chaise Lounge and Storage");
    expect(t).not.toMatch(/homcom|aosom|outsunny/i);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t).toMatch(/Sectional Sofa/);
    expect(cleanEnglishTitle("Outsunny Patio Dining Set")).toBe("Patio Dining Set");
  });

  it("tidyTitle cuts at a clean boundary with no dangling connector", () => {
    const t = tidyTitle("Canapé sectionnel en L avec méridienne et coussins en tissu lin", 40);
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t).not.toMatch(/s(et|avec|de|en|and|with|for)$/i);
    expect(tidyTitle("Table basse", 48)).toBe("Table basse");
    expect(tidyTitle("Mirror, with", 48)).toBe("Mirror");
    expect(tidyTitle("Armoire de rangement style fermette, 2 portes coulissantes et tiroirs", 40)).toBe("Armoire de rangement style fermette");
    expect(tidyTitle("Bibliothèque 5 niveaux en S — 15 compartiments ouverts", 34)).toBe("Bibliothèque 5 niveaux en S");
  });

  it("wrap keeps a question mark glued to its word", () => {
    expect(wrap("TU CHERCHAIS ÇA ?", 16, 2).every((l) => !/^[?!]/.test(l))).toBe(true);
  });
});
