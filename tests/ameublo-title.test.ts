import { describe, it, expect } from "vitest";
import { cleanTitle, endsClean, frenchify } from "@/lib/ameublo-i18n";
import { tipFor } from "@/lib/video-engines/ameublo-scenes";
import { productFamily } from "@/lib/ameublo-copy";

describe("endsClean", () => {
  it("rejects dangling endings", () => {
    for (const t of ["Table avec", "Buffet de cuisine style", "Bureau 47 / —", "Armoire (2 portes", "Coiffeuse…", "Lit 90", "Meuble et"]) {
      expect(endsClean(t), t).toBe(false);
    }
  });
  it("accepts complete titles, including words ending in le/la", () => {
    for (const t of ["Table", "Armoire à chaussures 3 portes", "Banc de rangement, lot de 2"]) expect(endsClean(t), t).toBe(true);
  });
});

describe("cleanTitle", () => {
  it("capitalises a lowercase start", () => {
    expect(cleanTitle("table basse en bois", "fr")).toBe("Table basse en bois");
  });
  it("keeps a short title untouched", () => {
    expect(cleanTitle("Banc de rangement en bois", "fr")).toBe("Banc de rangement en bois");
  });
  it("cuts at a clause, never mid-phrase", () => {
    const t = cleanTitle("Armoire de rangement haute avec 2 portes, étagères réglables et tiroir pour la salle de bain", "fr", 48);
    expect(t).not.toBeNull();
    expect(endsClean(t!)).toBe(true);
    expect(t!.length).toBeLessThanOrEqual(48);
  });
  it("returns null instead of a half-sentence", () => {
    expect(cleanTitle("Ensemble de salle à manger moderne rectangulaire sans aucune coupure possible ici", "fr", 30)).toBeNull();
  });
  it("keeps the quantity so the price is not read per unit", () => {
    const t = cleanTitle("Tabouret de bar réglable pivotant avec dossier, lot de 2 pour cuisine et comptoir", "fr", 48);
    expect(t).toMatch(/lot de 2/i);
  });
  it("never cuts away a set/ensemble", () => {
    const t = cleanTitle("Table basse avec ensemble de 2 tables gigognes en métal doré et verre trempé", "fr", 20);
    expect(t === null || /ensemble/i.test(t)).toBe(true);
  });
  it("replaces English words in French titles and refuses leftovers", () => {
    expect(frenchify("Garde-robe farmhouse teddy")).toBe("Garde-robe fermette peluche");
    expect(cleanTitle("Wooden storage cabinet", "fr")).toBeNull();
  });
  it("refuses French leftovers in English titles", () => {
    expect(cleanTitle("Armoire avec tiroirs", "en")).toBeNull();
  });
  it("honours the on-screen fit predicate", () => {
    expect(cleanTitle("Banc de rangement en bois massif, avec coussin", "fr", 48, (x) => x.length <= 20)).toBe("Banc de rangement en bois massif".length <= 20 ? "Banc de rangement en bois massif" : null);
  });
});

describe("tips and families", () => {
  it("armchairs and recliners do not get the sofa tip", () => {
    expect(tipFor("Accent chair velvet armchair", "fr")).toMatch(/fauteuil/i);
    expect(tipFor("Manual recliner chair", "en")).toMatch(/armchair/i);
  });
  it("a pet sofa gets the pet tip, not the sofa tip", () => {
    expect(tipFor("Pet sofa for dogs", "fr")).not.toMatch(/canap/i);
  });
  it("bathroom and vanity families", () => {
    expect(productFamily("Bathroom medicine cabinet")).toBe("bain");
    expect(productFamily("Dressing & vanity table")).toBe("chambre");
    expect(productFamily("Office desk")).toBe("bureau");
  });
});
