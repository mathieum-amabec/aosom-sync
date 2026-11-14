/**
 * SEO meta titles ("<product name> | <store>").
 *
 * Pure, dependency-free so ops scripts (scripts/fix-seo-titles.mts) can import it without
 * pulling in config / the LLM clients that content-generator.ts loads.
 *
 * History: until v0.5.107.36 the suffix was " | Livraison gratuite — Ameublo Direct" (37 chars).
 * Inside a 65-char budget that left ~28 chars for the name, and the word-boundary cut produced
 * titles like "Tables de chevet avec | Livraison gratuite — Ameublo Direct" on 350 products.
 * The suffix is now just the store name, and a truncated name never ends on a dangling word.
 */

export type MetaTitleLocale = "fr" | "en";

export const META_TITLE_MAX = 65;

export const META_TITLE_SUFFIX: Record<MetaTitleLocale, string> = {
  fr: " | Ameublo Direct",
  en: " | Furnish Direct",
};

/** Words a name must never end on (FR + EN articles, prepositions, connectors). */
const DANGLING_WORDS = new Set([
  // French
  "de", "du", "des", "à", "a", "et", "avec", "pour", "en", "le", "la", "les",
  "un", "une", "au", "aux", "sur", "sans", "ou", "par", "dans",
  // "— Lot de 4" / "ensemble de 2" cut after the noun (the prompt forbids a dangling "Lot" too)
  "lot", "ensemble",
  // English
  "of", "with", "for", "and", "the", "to", "in", "or", "on", "by",
]);

/** A token that is only separators / punctuation ("-", "—", ",", "x", "×", "/", "+", "&"). */
const SEPARATOR_TOKEN = /^(?:[-–—,;:/|+&×.]+|x)$/i;
/** A bare number or range ("3", "1,5", "12-18") — a cut dimension or count without its unit. */
const BARE_NUMBER = /^\d+(?:[.,]\d+)?(?:[-–]\d+(?:[.,]\d+)?)?$/;

/** An elided article left alone at the end: "d'", "l'", "qu'" (straight or curly apostrophe). */
const ELIDED = /^(?:d|l|qu)['’]$/i;

function isDanglingWord(token: string): boolean {
  // A bare "L" is a litre unit ("40 L") and a foot mark ("8'x2'") is not an elision: neither
  // is in the list, so both are kept.
  return ELIDED.test(token) || DANGLING_WORDS.has(token.toLowerCase());
}

/** True when the last word of `name` is a stopword/connector (not a number or separator). */
export function endsOnStopword(name: string): boolean {
  const tokens = name.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  return isDanglingWord(last.replace(/[,;:]+$/, ""));
}

/** True when the last word is a stopword, a bare number or a lone separator. */
export function endsOnDanglingToken(name: string): boolean {
  const tokens = name.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  if (!last) return false;
  const bare = last.replace(/[,;:]+$/, "");
  return (
    SEPARATOR_TOKEN.test(last) ||
    BARE_NUMBER.test(bare) ||
    isDanglingWord(bare)
  );
}

/**
 * Remove trailing stopwords, bare numbers and separators, repeatedly, from a name that was
 * cut at a word boundary. Compound tokens such as "2-en-1" are single tokens and survive.
 * An unclosed "(" left by the cut is dropped together with what follows it.
 */
export function stripDanglingTail(name: string): string {
  let out = name.replace(/\s+/g, " ").trim();
  // "Table pliante (60" → "Table pliante"
  const open = out.lastIndexOf("(");
  if (open !== -1 && out.indexOf(")", open) === -1) out = out.slice(0, open).trim();

  for (;;) {
    const before = out;
    out = out.replace(/[\s,;:]+$/, "").trim();
    const idx = out.lastIndexOf(" ");
    const last = idx === -1 ? out : out.slice(idx + 1);
    // Only ever drop a word when something remains before it.
    if (idx !== -1 && endsOnDanglingToken(last)) out = out.slice(0, idx).trim();
    if (out === before) break;
  }
  return out;
}

/**
 * Clamp a "Name | suffix" meta title to `max` chars WITHOUT cutting the suffix. If too long,
 * trim the name part at a word boundary, then strip any dangling stopword / number /
 * separator the cut left behind. Falls back to a plain slice if there is no " | ".
 */
export function clampMetaTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  const sepIdx = title.indexOf(" | ");
  if (sepIdx === -1) return title.slice(0, max);
  const suffix = title.slice(sepIdx);
  const room = max - suffix.length;
  if (room <= 3) return title.slice(0, max); // suffix alone ~fills the budget
  const full = title.slice(0, sepIdx);
  let name = full.slice(0, room);
  // Cut mid-word only when the next char isn't a space; otherwise the slice already ends on a word.
  if (full[room] !== undefined && full[room] !== " ") {
    const lastSpace = name.lastIndexOf(" ");
    if (lastSpace > 0) name = name.slice(0, lastSpace);
  }
  const cleaned = stripDanglingTail(name);
  return (cleaned || name.trimEnd()) + suffix;
}

/** Build "<name> | <store>" for a locale, clamped to `max` with a clean word-boundary cut. */
export function buildMetaTitle(name: string, locale: MetaTitleLocale, max = META_TITLE_MAX): string {
  // A name that already carries a " | …" tail (old suffix, model output) keeps only its name part.
  const bare = name.split(" | ")[0].replace(/\s+/g, " ").trim().replace(/[\s,;:—–-]+$/, "").trim();
  return clampMetaTitle(`${bare}${META_TITLE_SUFFIX[locale]}`, max);
}

/**
 * Safety net for a model-written meta title: keep the model's name part when it is sound,
 * otherwise (empty, or ending on a stopword) rebuild from the product title. The store suffix
 * is always re-applied, so an old-pattern "| Livraison gratuite — …" tail is replaced too.
 */
export function normalizeMetaTitle(
  modelTitle: string,
  fallbackName: string,
  locale: MetaTitleLocale,
  max = META_TITLE_MAX,
): string {
  const namePart = (modelTitle ?? "").split(" | ")[0].trim();
  const source = !namePart || endsOnStopword(namePart) ? fallbackName : namePart;
  return buildMetaTitle(source, locale, max);
}
