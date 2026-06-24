// Smart, readable product-title shortener for video overlays.
//
// Why this exists: the demand-gen renderer (scripts/render-demand-gen.mjs) and the
// slideshow engine (src/lib/video-engines/ffmpeg-slideshow.ts) used to hard-truncate
// titles to N chars and append an ellipsis ("…"), producing ugly overlays like
// "CLIMATISEUR PORTATIF 10 000 BTU…". formatVideoTitle replaces that with a clean,
// word-boundary shortening: no ellipsis ever, never cuts mid-word, drops the trailing
// "AVEC …" clause, and (in `aggressive` mode) drops decorative descriptors + filler so
// the title fits ~40 chars and reads well.
//
// Two modes:
//   - aggressive + uppercase (default): the demand-gen overlay style — UPPERCASE (fr-CA)
//     with catalogue-specific cleanup (REMOVE_WORDS / PHRASE_REDUCTIONS / leading drop).
//   - { aggressive:false, uppercase:false }: the slideshow style — preserve the product
//     name's casing and wording, only strip the ellipsis, the "AVEC …" tail, and over-length.
//
// REMOVE_WORDS / PHRASE_REDUCTIONS are curated for the French (fr-CA) Aosom catalogue and
// meant to be extended as new noisy titles surface — conservative (whole-word, accent-aware).

/** Decorative descriptors dropped anywhere in the title (whole-word, fr-CA upper-cased). */
const REMOVE_WORDS = new Set(["PORTATIF", "OSCILLANT", "CARRÉ", "CARRÉE", "RÉSINE"]);

/** Leading nouns that add no value on an overlay ("ENSEMBLE TABLE…" → "TABLE…"). */
const LEADING_DROP = new Set(["ENSEMBLE"]);

/** Trailing connector/filler words stripped repeatedly from the end (compared upper-cased). */
const TRAILING_FILLER = new Set(["AVEC", "EN", "DE", "ET", "POUR"]);

/** Materials kept, but with their "EN " connector dropped ("EN MÉTAL" → "MÉTAL"). */
const MATERIALS = ["MÉTAL", "ACIER", "BOIS", "ROTIN", "VERRE", "ALUMINIUM"];

/**
 * Catalogue-specific phrase reductions the generic rules can't capture cleanly.
 * Matched on the UPPER-cased title (aggressive mode upper-cases before this runs).
 * Kept tiny and explicit — semantic "DE" removal ("BASE DE PARASOL" reads fine as
 * "BASE PARASOL", but "CADRE DE LIT" / "TABLE DE BAR" must keep their "DE").
 */
const PHRASE_REDUCTIONS: Array<[RegExp, string]> = [[/\bBASE DE PARASOL\b/g, "BASE PARASOL"]];

const up = (s: string): string => s.toLocaleUpperCase("fr-CA");

function stripTrailingFiller(t: string): string {
  const parts = t.split(" ");
  while (parts.length > 1 && TRAILING_FILLER.has(up(parts[parts.length - 1]))) parts.pop();
  return parts.join(" ");
}

export interface FormatVideoTitleOptions {
  /** Upper-case the result (fr-CA). Default true. */
  uppercase?: boolean;
  /** Apply catalogue cleanup (decorative words, leading drop, phrase reductions). Default true. */
  aggressive?: boolean;
}

/**
 * Produit un titre court et lisible pour les overlays vidéo.
 * - Max `maxChars` caractères (défaut 40), coupé UNIQUEMENT sur un espace.
 * - Jamais de "…"/"..." (les ellipses existantes sont retirées, aucune n'est ajoutée).
 * - Retire le suffixe "AVEC …" et les mots de remplissage finaux.
 * - En mode `aggressive` : retire les descripteurs décoratifs + met en MAJUSCULES (fr-CA).
 */
export function formatVideoTitle(
  rawTitle: string,
  maxChars = 40,
  opts: FormatVideoTitleOptions = {},
): string {
  const { uppercase = true, aggressive = true } = opts;
  if (!rawTitle) return "";

  // 1. Strip any existing ellipsis, normalize dashes + whitespace (casing preserved here).
  let t = rawTitle
    .replace(/…/g, " ")
    .replace(/\.\.\./g, " ")
    .replace(/\s*[—–]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 2. Drop the "AVEC …" suffix (and a bare trailing "AVEC"), case-insensitive.
  t = t.replace(/\s+AVEC\b.*$/iu, "").trim();

  // 3. Catalogue cleanup (demand-gen overlays) — operates on the upper-cased form.
  if (aggressive) {
    t = up(t);
    const lead = t.split(" ");
    if (lead.length > 1 && LEADING_DROP.has(lead[0])) t = lead.slice(1).join(" ");
    t = t.replace(new RegExp(`\\bEN (${MATERIALS.join("|")})\\b`, "gu"), "$1");
    for (const [pattern, replacement] of PHRASE_REDUCTIONS) t = t.replace(pattern, replacement);
    t = t
      .split(" ")
      .filter((w) => !REMOVE_WORDS.has(w))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 4. Strip trailing filler words.
  t = stripTrailingFiller(t);

  // 5. Enforce the length cap on a word boundary — never mid-word, never an ellipsis.
  if (t.length > maxChars) {
    const slice = t.slice(0, maxChars + 1); // +1 so a space exactly at the cap counts
    const lastSpace = slice.lastIndexOf(" ");
    t = (lastSpace > 0 ? slice.slice(0, lastSpace) : t.slice(0, maxChars)).trim();
    t = stripTrailingFiller(t); // a word cut could re-expose a trailing filler
  }

  t = t.trim();
  return uppercase ? up(t) : t;
}
