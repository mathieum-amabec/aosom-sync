import { describe, it, expect } from "vitest";
import {
  countTitleWords,
  capTitleWords,
  stripColourFromTitle,
  convertImperialInTitle,
  findImperialOnly,
  findUnaccentedFrench,
  convertImperialSize,
  repairFrenchSlips,
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
  it("leaves a title at or under 8 words untouched", () => {
    const t = "Banc de jardin en bois rustique 107 cm";
    expect(capTitleWords(t)).toBe(t);
  });
  it("cuts an over-long title at a word boundary and drops a dangling connector", () => {
    const t = "Chaise de salle à manger rembourrée en lin avec dossier haut et pieds en acier noir";
    const out = capTitleWords(t);
    expect(countTitleWords(out)).toBeLessThanOrEqual(8);
    expect(out).not.toMatch(/\b(de|du|avec|et|en|à|pour)$/i);
    expect(t.startsWith(out)).toBe(true);
  });
  it("never cuts inside a dimension group", () => {
    const out = capTitleWords("Abri de jardin en acier galvanisé résistant aux intempéries avec porte 6 x 4 m", 9);
    expect(out).not.toMatch(/\b6 x$/);
  });
  it("never drops the piece count (chairs bug 2026-10-05: '— Lot de 4 chaises' became '— Lot')", () => {
    const out = capTitleWords("Chaises de salle à manger en similicuir — Lot de 4");
    expect(out).toBe("Chaises de salle à manger en similicuir — Lot de 4");
  });
  it("shortens the words around the piece count instead of cutting it", () => {
    const out = capTitleWords("Chaises de salle à manger modernes rembourrées en similicuir noir avec pieds en acier — Lot de 4");
    expect(out).toMatch(/Lot de 4$/);
    expect(countTitleWords(out)).toBeLessThanOrEqual(8);
    expect(out).not.toMatch(/\b(de|avec|en)\s+—/);
  });
  it("keeps a leading piece count in place", () => {
    const out = capTitleWords("Ensemble de 6 chaises de salle à manger modernes rembourrées en tissu avec pieds en bois");
    expect(out.startsWith("Ensemble de 6 chaises")).toBe(true);
    expect(countTitleWords(out)).toBeLessThanOrEqual(8);
  });
  it("does not mistake a measurement for a piece count", () => {
    expect(countTitleWords("Table d'appoint ensemble de 40 cm")).toBe(5);
  });
});

describe("capTitleWords — capacity stays whole", () => {
  it("never leaves a bare number: '5-8 personnes' is one word (ice tent bug 2026-11-19)", () => {
    const out = capTitleWords("Abri de pêche sur glace portable pliable pop-up isolé 5-8 personnes");
    expect(out).not.toMatch(/sd+(?:-d+)?$/);
    expect(countTitleWords(out)).toBeLessThanOrEqual(8);
  });
  it("counts a capacity as one word", () => {
    expect(countTitleWords("Abri de pêche sur glace pop-up 5-8 personnes")).toBe(7);
  });
});

describe("stripColourFromTitle", () => {
  it("always removes a trailing '— colour' segment", () => {
    expect(stripColourFromTitle("Chaise longue pliante — gris", false)).toBe("Chaise longue pliante");
    expect(stripColourFromTitle("Armoire Pantry Farmhouse 72 cm — Noir", false)).toBe("Armoire Pantry Farmhouse 72 cm");
    expect(stripColourFromTitle("Abri automobile 6 x 4 m — gris foncé", false)).toBe("Abri automobile 6 x 4 m");
  });
  it("removes a colour segment in the MIDDLE of the title (Jaune bug 2026-11-19)", () => {
    expect(stripColourFromTitle("Ensemble table et 4 chaises pour enfants — Jaune — Lot de 5", false)).toBe(
      "Ensemble table et 4 chaises pour enfants — Lot de 5",
    );
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

describe("ensureTitlePieceCount", () => {
  it("does not turn 'table + 4 chaises' (5 pieces) into a false 'Lot de 5'", () => {
    expect(ensureTitlePieceCount("Ensemble table et 4 chaises pour enfants", 5, "fr")).toBe("Ensemble table et 4 chaises pour enfants");
  });
  it("still appends the count when the title does not carry it", () => {
    expect(ensureTitlePieceCount("Chaises de salle à manger", 4, "fr")).toBe("Chaises de salle à manger — Lot de 4");
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

import { inferPieceCount, mentionsPieceCount, ensureTitlePieceCount } from "../src/lib/content-guards";

describe("piece count", () => {
  it("reads the set size from a supplier title or size label", () => {
    expect(inferPieceCount("High Back Dining Chairs, Set of 4, Black")).toBe(4);
    expect(inferPieceCount("x", "Set of 6")).toBe(6);
    expect(inferPieceCount("Folding Chairs 6 Pack")).toBe(6);
    expect(inferPieceCount("Single Chair")).toBeNull();
    expect(inferPieceCount("Set of 1")).toBeNull();
  });
  it("detects the count as digits or words, but not a measurement", () => {
    expect(mentionsPieceCount("Ce lot de 4 chaises", 4)).toBe(true);
    expect(mentionsPieceCount("Ces quatre chaises", 4)).toBe(true);
    expect(mentionsPieceCount("Améliorez votre espace repas avec ces chaises modernes", 4)).toBe(false);
    expect(mentionsPieceCount("Hauteur 4 cm", 4)).toBe(false);
  });
  it("appends the count to a title that lost it, and leaves a complete title alone", () => {
    expect(ensureTitlePieceCount("Chaises de salle à manger modernes", 4, "fr")).toBe(
      "Chaises de salle à manger modernes — Lot de 4",
    );
    expect(ensureTitlePieceCount("Chaises modernes — Lot de 4", 4, "fr")).toBe("Chaises modernes — Lot de 4");
    expect(ensureTitlePieceCount("Chaise", null, "fr")).toBe("Chaise");
  });
});

describe("convertImperialSize — Taille option values in metric", () => {
  it("converts a W x D x H label written with inch marks", () => {
    expect(convertImperialSize('9.3" x 9.3" x 72.4"')).toBe("24 x 24 x 184 cm");
  });
  it("converts the W/D/H lettered form and feet", () => {
    expect(convertImperialSize('31.5"W x 15.7"D')).toBe("80 cm W x 40 cm D");
    expect(convertImperialSize("6 pi")).toBe("183 cm");
  });
  it("leaves metric, mixed and word labels alone", () => {
    expect(convertImperialSize("6 pi (183 cm)")).toBe("6 pi (183 cm)");
    expect(convertImperialSize("120 cm")).toBe("120 cm");
    expect(convertImperialSize("Lot de 4")).toBe("Lot de 4");
    expect(convertImperialSize("Grand")).toBe("Grand");
  });
});

describe("repairFrenchSlips", () => {
  it("fixes the slips the judge held products for (2026-11-19)", () => {
    expect(repairFrenchSlips("Chemalet d'artiste pliant en pin")).toBe("Chevalet d'artiste pliant en pin");
    expect(repairFrenchSlips("Caissier de classeur vertical à 2 tiroirs")).toBe("Classeur vertical à 2 tiroirs");
    expect(repairFrenchSlips("Caissson mobile à 4 tiroirs")).toBe("Caisson mobile à 4 tiroirs");
    expect(repairFrenchSlips("panneau en méelamine")).toBe("panneau en mélamine");
    expect(repairFrenchSlips("chemalets")).toBe("chevalets");
  });
  it("leaves correct French alone", () => {
    expect(repairFrenchSlips("Chevalet en mélamine, caisson et classeur")).toBe("Chevalet en mélamine, caisson et classeur");
  });
});
