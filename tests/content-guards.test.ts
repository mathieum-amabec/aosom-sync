import { describe, it, expect } from "vitest";
import {
  countTitleWords,
  capTitleWords,
  stripColourFromTitle,
  convertImperialInTitle,
  findImperialOnly,
  findUnaccentedFrench,
} from "@/lib/content-guards";

describe("countTitleWords — a dimension group is ONE word", () => {
  it("counts '3 x 4 m' as a single word", () => {
    // A real Gemini title that looks like 11 words by whitespace: 8 words + 1 dimension.
    expect(countTitleWords("Gazebo rigide de jardin avec toit en polycarbonate 3 x 4 m")).toBe(9);
  });
  it("ignores dash separators", () => {
    expect(countTitleWords("Chaise longue pliante — gris")).toBe(4);
  });
  it("does not split 'pièces' into a unit", () => {
    expect(countTitleWords("Canapé modulaire enfant 12 pièces")).toBe(5);
  });
});

describe("capTitleWords", () => {
  it("leaves a title at or under 10 words untouched", () => {
    const t = "Banc de jardin en bois roue de chariot rustique 107 cm";
    expect(capTitleWords(t)).toBe(t);
  });
  it("cuts an over-long title at a word boundary and drops a dangling connector", () => {
    const t = "Chaise de salle à manger rembourrée en lin avec dossier haut et pieds en acier noir";
    const out = capTitleWords(t);
    expect(countTitleWords(out)).toBeLessThanOrEqual(10);
    expect(out).not.toMatch(/\b(de|du|avec|et|en|à|pour)$/i);
    expect(t.startsWith(out)).toBe(true);
  });
  it("never cuts inside a dimension group", () => {
    const out = capTitleWords("Abri de jardin en acier galvanisé résistant aux intempéries avec porte 6 x 4 m", 9);
    expect(out).not.toMatch(/\b6 x$/);
  });
});

describe("stripColourFromTitle", () => {
  it("always removes a trailing '— colour' segment", () => {
    expect(stripColourFromTitle("Chaise longue pliante — gris", false)).toBe("Chaise longue pliante");
    expect(stripColourFromTitle("Armoire Pantry Farmhouse 72 cm — Noir", false)).toBe("Armoire Pantry Farmhouse 72 cm");
    expect(stripColourFromTitle("Abri automobile 6 x 4 m — gris foncé", false)).toBe("Abri automobile 6 x 4 m");
  });
  it("removes an inline colour only when the product has several colours", () => {
    expect(stripColourFromTitle("Sapin artificiel blanc 213 cm", true)).toBe("Sapin artificiel 213 cm");
    expect(stripColourFromTitle("Sapin artificiel blanc 213 cm", false)).toBe("Sapin artificiel blanc 213 cm");
  });
  it("does not touch words that merely contain a colour", () => {
    expect(stripColourFromTitle("Tabouret orangerie en bois", true)).toBe("Tabouret orangerie en bois");
    expect(stripColourFromTitle("Chaise en noyer massif", false)).toBe("Chaise en noyer massif");
  });
});

describe("convertImperialInTitle", () => {
  it("converts inches to cm (the real offenders)", () => {
    expect(convertImperialInTitle("Foyer électrique 27 po avec manteau")).toBe("Foyer électrique 69 cm avec manteau");
    expect(convertImperialInTitle("Tapis de jeu pliant pour bébé 77 x 69 po")).toBe("Tapis de jeu pliant pour bébé 196 x 175 cm");
  });
  it("converts feet, and switches to metres past 3 m", () => {
    expect(convertImperialInTitle("Remise de jardin 6x4,5pi")).toBe("Remise de jardin 183 x 137 cm");
    expect(convertImperialInTitle("Pergola 20 x 13 pi")).toBe("Pergola 6,1 x 4 m");
  });
  it("uses a decimal point in English", () => {
    expect(convertImperialInTitle("Pergola 20 x 13 ft", "en")).toBe("Pergola 6.1 x 4 m");
    expect(convertImperialInTitle("Foyer 27 in", "en")).toBe("Foyer 69 cm");
  });
  it("converts pounds to kg", () => {
    expect(convertImperialInTitle("Haltère 50 lb")).toBe("Haltère 23 kg");
  });
  it("leaves metric values, '3 in 1' features and 'pièces' alone", () => {
    expect(convertImperialInTitle("Tricycle 3 in 1 évolutif")).toBe("Tricycle 3 in 1 évolutif");
    expect(convertImperialInTitle("Canapé modulaire 12 pièces")).toBe("Canapé modulaire 12 pièces");
    expect(convertImperialInTitle("Armoire 180 x 137 cm")).toBe("Armoire 180 x 137 cm");
  });
});

describe("findImperialOnly — dual units are fine, imperial-only is not", () => {
  it("accepts a metric value beside the imperial one", () => {
    expect(findImperialOnly("Pièce de 30 m² (323 pi²) et jusqu'à 30 kg (66 lb).")).toEqual([]);
    expect(findImperialOnly("Hauteur réglable de 47 cm à 57 cm (18,5 po à 22,4 po)")).toEqual([]);
  });
  it("reports an imperial-only value", () => {
    expect(findImperialOnly("Hauteur de 38,25 po - dimension idéale")).toEqual(["38,25 po"]);
    expect(findImperialOnly("A 7 ft artificial tree")).toEqual(["7 ft"]);
  });
  it("does not mistake 'pièces' or '3 in 1' for units", () => {
    expect(findImperialOnly("Ensemble de 12 pièces, tricycle 3 in 1")).toEqual([]);
  });
});

describe("findUnaccentedFrench", () => {
  it("flags accent-less spellings", () => {
    expect(findUnaccentedFrench("Tapis de jeu pliable pour bebe imperméable")).toEqual(["bebe → bébé"]);
    expect(findUnaccentedFrench("Rangement pour l'exterieur")).toEqual(["exterieur → extérieur"]);
  });
  it("passes correctly accented French", () => {
    expect(findUnaccentedFrench("Tapis de jeu pour bébé, sécurité et résistance")).toEqual([]);
  });
});
