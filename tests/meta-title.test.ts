import { describe, it, expect } from "vitest";
import {
  buildMetaTitle,
  clampMetaTitle,
  normalizeMetaTitle,
  stripDanglingTail,
  endsOnStopword,
  endsOnDanglingToken,
  META_TITLE_SUFFIX,
} from "@/lib/meta-title";

const OLD_FR = " | Livraison gratuite — Ameublo Direct";
const nameOf = (t: string) => t.split(" | ")[0];

describe("buildMetaTitle", () => {
  it("uses the short store suffix", () => {
    expect(buildMetaTitle("Tabouret de bar", "fr")).toBe("Tabouret de bar | Ameublo Direct");
    expect(buildMetaTitle("Bar stool", "en")).toBe("Bar stool | Furnish Direct");
    expect(META_TITLE_SUFFIX.fr).toBe(" | Ameublo Direct");
    expect(META_TITLE_SUFFIX.en).toBe(" | Furnish Direct");
  });

  // The three production titles measured 2026-10-16, rebuilt from plausible full FR titles.
  const real = [
    "Tables de chevet avec tiroirs et étagère ouverte pour chambre à coucher — Lot de 2",
    "Bureau d'ordinateur 3 niveaux avec étagères de rangement et support pour moniteur",
    "Voiture électrique 2 personnes pour enfants 12 V avec télécommande et musique",
  ];

  it.each(real)("never ends on a dangling word: %s", (full) => {
    const out = buildMetaTitle(full, "fr");
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith(" | Ameublo Direct")).toBe(true);
    expect(endsOnDanglingToken(nameOf(out))).toBe(false);
    expect(full.startsWith(nameOf(out))).toBe(true);
  });

  it("repairs the old-suffix clamp of the real examples", () => {
    expect(clampMetaTitle(`${real[0]}${OLD_FR}`, 65)).toBe(`Tables de chevet${OLD_FR}`);
    expect(clampMetaTitle(`${real[1]}${OLD_FR}`, 65)).toBe(`Bureau d'ordinateur${OLD_FR}`);
    expect(clampMetaTitle(`${real[2]}${OLD_FR}`, 65)).toBe(`Voiture électrique${OLD_FR}`);
  });

  it("keeps 2-en-1 / 5-en-1 intact", () => {
    const out = buildMetaTitle("Chaise haute 2-en-1 pour bébé convertible en table et chaise avec plateau", "fr");
    expect(nameOf(out)).toContain("2-en-1");
    expect(endsOnDanglingToken(nameOf(out))).toBe(false);
    expect(buildMetaTitle("Table de jeux 5-en-1", "fr")).toBe("Table de jeux 5-en-1 | Ameublo Direct");
    expect(stripDanglingTail("Banc de jardin 2-en-1")).toBe("Banc de jardin 2-en-1");
  });

  it("strips trailing separators, numbers and elided articles repeatedly", () => {
    expect(stripDanglingTail("Étagère murale — 3 x")).toBe("Étagère murale");
    expect(stripDanglingTail("Table d'appoint avec la")).toBe("Table d'appoint");
    expect(stripDanglingTail("Lampe de l'")).toBe("Lampe");
    expect(stripDanglingTail("Table pliante (60 x")).toBe("Table pliante");
    expect(stripDanglingTail("Chaise de jardin,")).toBe("Chaise de jardin");
  });

  it("does not touch a name that fits, even one ending on a count", () => {
    expect(buildMetaTitle("Chaises de salle à manger — Lot de 4", "fr")).toBe(
      "Chaises de salle à manger — Lot de 4 | Ameublo Direct",
    );
  });

  it("drops an existing ' | …' tail before re-applying the suffix", () => {
    expect(buildMetaTitle(`Tabouret de bar${OLD_FR}`, "fr")).toBe("Tabouret de bar | Ameublo Direct");
  });

  it("handles EN", () => {
    const out = buildMetaTitle(
      "Outdoor patio dining set with cushions and umbrella hole for 6 people",
      "en",
    );
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith(" | Furnish Direct")).toBe(true);
    expect(endsOnDanglingToken(nameOf(out))).toBe(false);
    expect(clampMetaTitle("Kids ride-on car with remote and music for | Free Shipping — Furnish Direct", 65))
      .toBe("Kids ride-on car with remote | Free Shipping — Furnish Direct");
  });

  it("stays within a custom max", () => {
    for (const max of [40, 50, 65, 70]) {
      const out = buildMetaTitle("Armoire de rangement haute avec portes et tablettes réglables pour salle de bain", "fr", max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(endsOnDanglingToken(nameOf(out))).toBe(false);
    }
  });
});

describe("normalizeMetaTitle (model safety net)", () => {
  it("keeps a sound model name and swaps the old suffix", () => {
    expect(normalizeMetaTitle(`Tabouret de bar réglable${OLD_FR}`, "Tabouret", "fr")).toBe(
      "Tabouret de bar réglable | Ameublo Direct",
    );
  });

  it("rebuilds from the product title when the model's name ends on a stopword", () => {
    expect(normalizeMetaTitle(`Tables de chevet avec${OLD_FR}`, "Tables de chevet avec tiroir", "fr")).toBe(
      "Tables de chevet avec tiroir | Ameublo Direct",
    );
    expect(normalizeMetaTitle("Patio set with | Furnish Direct", "Patio set with cushions", "en")).toBe(
      "Patio set with cushions | Furnish Direct",
    );
  });

  it("rebuilds from the product title when the model returned nothing usable", () => {
    expect(normalizeMetaTitle("", "Chaise longue", "fr")).toBe("Chaise longue | Ameublo Direct");
  });
});

describe("stopword detection", () => {
  it("flags stopwords but not content words", () => {
    expect(endsOnStopword("Tables de chevet avec")).toBe(true);
    expect(endsOnStopword("Bureau d'")).toBe(true);
    expect(endsOnStopword("Bureau d'ordinateur")).toBe(false);
    expect(endsOnDanglingToken("Voiture électrique 2")).toBe(true);
    expect(endsOnDanglingToken("Table 2-en-1")).toBe(false);
    // A foot mark is not an elided article, and a bare "L" is litres.
    expect(endsOnStopword("Poubelle double 40 L")).toBe(false);
    expect(endsOnDanglingToken("Bureau en L")).toBe(false);
    expect(stripDanglingTail("Chaises de salle à manger — Lot")).toBe("Chaises de salle à manger");
    expect(stripDanglingTail("Armoire à chaussures 3 tiroirs 12-18")).toBe("Armoire à chaussures 3 tiroirs");
    expect(stripDanglingTail("Chaises rembourrées ensemble")).toBe("Chaises rembourrées");
    expect(endsOnDanglingToken("Bac surélevé 8'x2'")).toBe(false);
    expect(stripDanglingTail("Moustiquaire gazebo 10'x13'")).toBe("Moustiquaire gazebo 10'x13'");
  });
});
