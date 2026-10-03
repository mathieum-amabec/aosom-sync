/**
 * French labels for Aosom size option values ("Large" → "Grand", "Set of 4" → "Lot de 4",
 * "3-Drawer" → "3 tiroirs", "6FT" → "6 pi").
 *
 * Why (2026-10-02): the FR store showed 332 English size values on 264 products. They were
 * translated in bulk that day; this module makes NEW imports arrive in French too, with the
 * original Aosom wording registered as the EN translation (see registerOptionEnTranslations).
 *
 * Deliberately WORDS only: inch marks ("), metric units and decimal points are left as Aosom
 * wrote them — converting those would rewrite ~1,300 products' variant labels for no shopper
 * benefit (" is universally read in Canada). Rules are deterministic, no AI.
 */

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/\bone size\b/gi, "Taille unique"],
  [/\bx-large\b|\bextra large\b/gi, "Très grand"],
  [/\blarge\b/gi, "Grand"],
  [/\bmedium\b/gi, "Moyen"],
  [/\bsmall\b/gi, "Petit"],
  [/\btwin\b/gi, "Simple"],
  [/\bfull\b/gi, "Double"],
  [/\bset of (\d+)\b/gi, "Lot de $1"],
  [/\b(\d+) count \(pack of 1\)/gi, "$1 unité(s)"],
  [/\bpack of (\d+)\b/gi, "Paquet de $1"],
  [/\b1 (piece|pc|pcs)\b/gi, "1 pièce"],
  [/\b(\d+) (pieces|pcs)\b/gi, "$1 pièces"],
  [/\b(\d+)-pieces?\b/gi, "$1 pièces"],
  [/\b(\d+) flip drawers\b/gi, "$1 tiroirs basculants"],
  [/\b(\d+)[- ]?drawers?\b/gi, (_m, n) => `${n} tiroir${n === "1" ? "" : "s"}`],
  [/\b(\d+)[- ]?doors?\b/gi, (_m, n) => `${n} porte${n === "1" ? "" : "s"}`],
  [/\b(\d+)[- ]?tiers?\b/gi, (_m, n) => `${n} étage${n === "1" ? "" : "s"}`],
  [/\b(\d+)[- ]?panels?\b/gi, (_m, n) => `${n} panneau${n === "1" ? "" : "x"}`],
  [/\b(\d+)[- ]?(shelf|shelves)\b/gi, (_m, n) => `${n} tablette${n === "1" ? "" : "s"}`],
  [/\btwo seat(er)?\b/gi, "2 places"],
  [/\b(\d+)[- ]?seat(er)?s?\b/gi, "$1 places"],
  [/\bround\b/gi, "Rond"],
  [/\bsquare\b/gi, "Carré"],
  [/\brectangular\b|\brectangle\b/gi, "Rectangulaire"],
  [/\boval\b/gi, "Ovale"],
  [/\bwithout foundation kit\b/gi, "sans kit de fondation"],
  [/\bwith foundation kit\b/gi, "avec kit de fondation"],
  [/"\s*wide\b/gi, "\" de large"],
  [/"\s*tall\b/gi, "\" de haut"],
  [/\bcu\.? ?ft\b/gi, "pi³"],
  [/\binches\b|\binch\b/gi, "po"],
  [/(\d)\s?(ft|feet|foot)\b/gi, "$1 pi"],
  [/\bft\b/gi, "pi"],
  [/(\d)\.(\d+) pi\b/g, "$1,$2 pi"],
];

/** French label for an Aosom size value; returned unchanged when no rule applies. */
export function toFrenchSize(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return v;
  let s = v;
  for (const [re, to] of RULES) s = s.replace(re, to as never);
  if (s === v) return v;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
