/**
 * Colour labels for variant options: the FR store shows French, the EN locale (Furnish
 * Direct) shows English via a Shopify translation of the option value.
 *
 * The Aosom feed's `color` field is English and free-form ("Rustic Brown", "Natural Wood
 * and Black", "Grey, White, Black"). The original 25-entry map left everything else in
 * English on the FR store (audit 2026-09-30: 300+ variants, e.g. "Black" ×70, "Yellow" ×31).
 * This module translates whole phrases first, then compounds part by part, and keeps a
 * trailing disambiguation number ("Noir 2"). Anything it can't fully translate is returned
 * unchanged — a slightly-untranslated colour beats a wrong one.
 */

const EN_TO_FR: Record<string, string> = {
  black: "Noir", white: "Blanc", grey: "Gris", gray: "Gris",
  "dark grey": "Gris foncé", "dark gray": "Gris foncé", "light grey": "Gris pâle", "light gray": "Gris pâle",
  charcoal: "Gris charbon", "charcoal grey": "Gris charbon", "carbon grey": "Gris carbone", "ash grey": "Gris cendré",
  brown: "Brun", "dark brown": "Brun foncé", "light brown": "Brun pâle", "rustic brown": "Brun rustique",
  "distressed brown": "Brun vieilli", "coffee brown": "Brun café", "light mixed brown": "Brun mélangé pâle", coffee: "Café",
  green: "Vert", "dark green": "Vert foncé", "light green": "Vert pâle", "forest green": "Vert forêt", "mixed green": "Vert mélangé",
  blue: "Bleu", "dark blue": "Bleu foncé", "light blue": "Bleu pâle", "sky blue": "Bleu ciel", "navy blue": "Bleu marine",
  red: "Rouge", "wine red": "Rouge vin", pink: "Rose", orange: "Orange", yellow: "Jaune", purple: "Violet", turquoise: "Turquoise",
  beige: "Beige", "beige grey": "Beige gris", tan: "Beige foncé", cream: "Crème", "cream white": "Blanc crème",
  khaki: "Kaki", silver: "Argent", gold: "Or", bronze: "Bronze", clear: "Transparent",
  natural: "Naturel", "natural wood": "Bois naturel", "natural finish": "Fini naturel", "natural wood finish": "Fini bois naturel",
  "vintage natural": "Naturel vintage", oak: "Chêne", "light oak": "Chêne pâle",
  walnut: "Noyer", walunt: "Noyer", "light walnut": "Noyer pâle", "dark walnut": "Noyer foncé", "dark walunt": "Noyer foncé",
  "dark walnut wood grain": "Grain de noyer foncé", "brown wood grain": "Grain de bois brun", "white wood grain": "Grain de bois blanc",
  "grey-brown wood grain": "Grain de bois gris-brun", "white wood effect": "Effet bois blanc", "white marble": "Marbre blanc",
  "high gloss marble-effect black": "Noir lustré effet marbre", "log colour": "Couleur bois",
  "multi colour": "Multicolore", multicolour: "Multicolore", "multi-colored": "Multicolore", "multi-coloured": "Multicolore",
  camouflage: "Camouflage", "flower pattern": "Motif floral", carbonized: "Carbonisé",
};

/** FR label → EN, for the EN-locale translation of existing French option values. */
const FR_TO_EN: Record<string, string> = {
  noir: "Black", blanc: "White", gris: "Grey", "gris foncé": "Dark grey", "gris pâle": "Light grey", "gris charbon": "Charcoal grey",
  "gris carbone": "Carbon grey", "gris cendré": "Ash grey", brun: "Brown", "brun foncé": "Dark brown", "brun pâle": "Light brown",
  "brun rustique": "Rustic brown", "brun vieilli": "Distressed brown", "brun café": "Coffee brown", "brun mélangé pâle": "Light mixed brown",
  café: "Coffee", vert: "Green", "vert foncé": "Dark green", "vert pâle": "Light green", "vert forêt": "Forest green", "vert mélangé": "Mixed green",
  bleu: "Blue", "bleu foncé": "Dark blue", "bleu pâle": "Light blue", "bleu ciel": "Sky blue", "bleu marine": "Navy blue",
  rouge: "Red", "rouge vin": "Wine red", rose: "Pink", orange: "Orange", jaune: "Yellow", violet: "Purple", turquoise: "Turquoise",
  beige: "Beige", "beige gris": "Beige grey", "beige foncé": "Tan", crème: "Cream", "blanc crème": "Cream white", kaki: "Khaki",
  argent: "Silver", or: "Gold", bronze: "Bronze", transparent: "Clear", naturel: "Natural", "bois naturel": "Natural wood",
  "fini naturel": "Natural finish", "fini bois naturel": "Natural wood finish", "naturel vintage": "Vintage natural",
  chêne: "Oak", "chêne pâle": "Light oak", noyer: "Walnut", "noyer pâle": "Light walnut", "noyer foncé": "Dark walnut",
  "grain de noyer foncé": "Dark walnut wood grain", "grain de bois brun": "Brown wood grain", "grain de bois blanc": "White wood grain",
  "grain de bois gris-brun": "Grey-brown wood grain", "effet bois blanc": "White wood effect", "marbre blanc": "White marble",
  "noir lustré effet marbre": "High-gloss marble-effect black", "couleur bois": "Wood colour", multicolore: "Multicolour",
  camouflage: "Camouflage", "motif floral": "Flower pattern", carbonisé: "Carbonized",
  "couleurs pâles": "Light colours", "couleurs foncées": "Dark colours", "blanc vieilli": "Antique white", "blanc lustré": "Glossy white",
  "blanc effet marbre": "Marble-effect white", défaut: "Default",
};

const SEPARATOR = /\s*(?:,|&|\band\b|\bet\b)\s*/i;

function translateWith(map: Record<string, string>, raw: string, joiner: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  // Keep a trailing disambiguation number ("Noir 2", "Green 1") added by the importer.
  const m = trimmed.match(/^(.*?)(\s+\d+)?$/);
  const base = (m?.[1] ?? trimmed).trim();
  const suffix = m?.[2] ?? "";
  const whole = map[base.toLowerCase()];
  if (whole) return whole + suffix;
  const parts = base.split(SEPARATOR).filter(Boolean);
  if (parts.length < 2) return null;
  const translated = parts.map((p) => map[p.trim().toLowerCase()]);
  if (translated.some((t) => !t)) return null;
  const lowerTail = translated.map((t, i) => (i === 0 ? t! : t!.toLowerCase()));
  const joined = lowerTail.length === 2 ? lowerTail.join(` ${joiner} `) : `${lowerTail.slice(0, -1).join(", ")} ${joiner} ${lowerTail.at(-1)}`;
  return joined + suffix;
}

/** English feed colour → French label, or the input unchanged when not fully translatable. */
export function toFrenchColour(raw: string): string {
  return translateWith(EN_TO_FR, raw, "et") ?? raw;
}

/** French (or already-English) label → English, or null when unknown. */
export function toEnglishColour(label: string): string | null {
  const fr = translateWith(FR_TO_EN, label, "and");
  if (fr) return fr;
  // An English value left on a product (pre-translation import) is already English.
  return translateWith(EN_TO_FR, label, "et") ? (label || "").trim() : null;
}

/** True when the label is an English colour the FR store should not show as-is. */
export function isEnglishColour(label: string): boolean {
  const t = toFrenchColour(label);
  return t !== label && t.trim() !== (label || "").trim();
}
