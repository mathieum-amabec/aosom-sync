/**
 * Deterministic guardrails for LLM-generated product copy.
 *
 * Pure functions, no I/O — applied by `generateProductContent` to whatever model wrote the
 * listing. Motivated by the 2026-10 Haiku-vs-Gemini A/B (30 products, same prompt): both models
 * broke the same prompt rules some of the time (colour in the title, > 10-word titles, inch
 * values left in the copy, a missing accent, too few tags), so the rules are enforced in code
 * instead of trusted to the prompt — which also removes the quality gap between providers.
 *
 * Two kinds of guard:
 *   - FIX (title only): the model's title is repaired deterministically — a retry would cost
 *     more than the repair and the repair is lossless enough for a short title.
 *   - DETECT (body / tags): a problem is reported so the generator can ask the SAME model once
 *     to fix it. Rewriting prose with regexes would silently corrupt it.
 */

// ── Dimensions as one "word" ────────────────────────────────────────────────────────────────
// "6 x 4 m", "77 x 69 po" and "107 cm" are each ONE unit of information, not 3-4 words: a title
// like "Gazebo rigide de jardin avec toit en polycarbonate 3 x 4 m" is 9 words + 1 dimension.
const DIMENSION_RE =
  /\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)*(?:\s*(?:cm|mm|m²|m2|m|kg|g|l|w|v|po|pi|in|ft|lbs?)(?![\p{L}²])|\s*["″'])?/giu;

const MAX_TITLE_WORDS = 10;

/** Words that read as dangling when a title is cut right after them. */
const DANGLING = new Set([
  "de", "du", "des", "d'", "la", "le", "les", "l'", "un", "une", "pour", "avec", "et", "en", "à", "au", "aux", "sur",
  "sans", "ou", "the", "a", "an", "for", "with", "and", "of", "in", "on", "to", "without", "or",
]);

const PLACEHOLDER = (i: number) => `\u0001${i}\u0001`;

function protectDimensions(s: string): { text: string; dims: string[] } {
  const dims: string[] = [];
  const text = s.replace(DIMENSION_RE, (m) => {
    dims.push(m);
    return PLACEHOLDER(dims.length - 1);
  });
  return { text, dims };
}

function restoreDimensions(s: string, dims: string[]): string {
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => dims[Number(i)] ?? "");
}

const isSeparator = (w: string) => /^[—–\-|·]+$/.test(w);

/** Word count of a title, counting each dimension group ("3 x 4 m") as one word. */
export function countTitleWords(title: string): number {
  const { text } = protectDimensions(title);
  return text.split(/\s+/).filter((w) => w && !isSeparator(w)).length;
}

/**
 * Cap a title at `max` words (default 10) — the prompt's own rule ("truncate if necessary"),
 * enforced. Cuts at a word boundary, never inside a dimension group, and drops dangling
 * connectors so the result does not end on "…avec" or "…de".
 */
export function capTitleWords(title: string, max: number = MAX_TITLE_WORDS): string {
  if (countTitleWords(title) <= max) return title.trim();
  const { text, dims } = protectDimensions(title);
  const words = text.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  let n = 0;
  for (const w of words) {
    if (isSeparator(w)) { kept.push(w); continue; }
    if (n >= max) break;
    kept.push(w);
    n++;
  }
  while (kept.length) {
    const last = kept[kept.length - 1].toLowerCase().replace(/[.,;:]+$/, "");
    if (isSeparator(last) || DANGLING.has(last)) kept.pop();
    else break;
  }
  return restoreDimensions(kept.join(" "), dims).trim();
}

// ── Colour in the title ─────────────────────────────────────────────────────────────────────
// The prompt says colour is variant-level and must not be in the title. Only colour WORDS the
// store already uses are matched, so a product name that merely contains "or" or "rose" in
// another sense is not touched (those two are intentionally excluded).
const COLOUR_WORDS = [
  "noir", "noire", "blanc", "blanche", "gris", "grise", "gris foncé", "gris pâle", "gris clair", "brun", "brune",
  "brun foncé", "marron", "beige", "rouge", "bleu", "bleue", "bleu marine", "vert", "verte", "jaune", "orange",
  "violet", "violette", "argent", "argenté", "crème", "noyer", "chêne", "naturel", "naturelle", "bourgogne", "turquoise",
  "black", "white", "grey", "gray", "dark grey", "light grey", "brown", "dark brown", "red", "blue", "green", "yellow",
  "purple", "silver", "cream", "natural", "walnut", "oak", "burgundy",
];
// Longest first so "gris foncé" wins over "gris".
const COLOUR_ALT = [...new Set(COLOUR_WORDS)].sort((a, b) => b.length - a.length).map((c) => c.replace(/ /g, "\\s+")).join("|");
const TRAILING_COLOUR_RE = new RegExp(`\\s*[—–-]\\s*(?:${COLOUR_ALT})(?:\\s*(?:et|and|/|,)\\s*(?:${COLOUR_ALT}))*\\s*$`, "i");
const INLINE_COLOUR_RE = new RegExp(`(?<![\\p{L}\\d])(?:${COLOUR_ALT})(?![\\p{L}\\d])`, "giu");

/**
 * Remove colour from a generated title. A trailing "— gris" segment is always removed. Colour
 * words inside the title are removed only when the product has several colours
 * (`multiColour`): there the colour is a variant choice, and naming one in the title is wrong
 * for the others. A single-colour product may keep "Sapin artificiel blanc", which is a
 * description of the thing, not a variant label.
 */
export function stripColourFromTitle(title: string, multiColour: boolean): string {
  let out = title.replace(TRAILING_COLOUR_RE, "");
  if (multiColour) out = out.replace(INLINE_COLOUR_RE, " ");
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/[\s—–-]+$/, "").trim();
}

// ── Imperial units ──────────────────────────────────────────────────────────────────────────
const CM_PER_INCH = 2.54;
const CM_PER_FOOT = 30.48;
const KG_PER_LB = 0.45359237;

const UNIT_TO = (unit: string): { kind: "len" | "mass"; factor: number } | null => {
  const u = unit.toLowerCase().replace(/[″"]/g, "in");
  if (u === "po" || u === "in") return { kind: "len", factor: CM_PER_INCH };
  if (u === "pi" || u === "ft" || u === "'") return { kind: "len", factor: CM_PER_FOOT };
  if (u === "lb" || u === "lbs") return { kind: "mass", factor: KG_PER_LB };
  return null;
};

const num = (s: string) => Number(s.replace(",", "."));
const fmt = (n: number, locale: "fr" | "en", digits = 0) => {
  const s = n.toFixed(digits).replace(/\.0+$/, "");
  return locale === "fr" ? s.replace(".", ",") : s;
};

/**
 * Convert inch / foot / pound values in a TITLE to metric ("77 x 69 po" → "196 x 175 cm",
 * "6x4,5pi" → "183 x 137 cm", "20 x 13 pi" → "6,1 x 4 m"). Titles only: a dimension in a title
 * is a label, so the conversion is exact enough; the body is handled by detect-and-retry.
 */
export function convertImperialInTitle(title: string, locale: "fr" | "en" = "fr"): string {
  // `in` must not be followed by a digit: "3 in 1" is a product feature, not 3 inches.
  const re = /(\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)*)\s*(po|pi|ft|in(?!\s*\d)|lbs?|["″'])(?![\p{L}²])/giu;
  return title.replace(re, (whole, nums: string, unit: string) => {
    const spec = UNIT_TO(unit);
    if (!spec) return whole;
    const parts = nums.split(/\s*[x×]\s*/).map(num);
    if (parts.some((p) => !Number.isFinite(p))) return whole;
    if (spec.kind === "mass") return parts.map((p) => fmt(p * spec.factor, locale, p * spec.factor >= 10 ? 0 : 1)).join(" x ") + " kg";
    const cm = parts.map((p) => p * spec.factor);
    if (Math.max(...cm) >= 300) return cm.map((c) => fmt(c / 100, locale, 1)).join(" x ") + " m";
    return cm.map((c) => fmt(c, locale)).join(" x ") + " cm";
  });
}

const IMPERIAL_RE = /\d+(?:[.,]\d+)?\s?(?:po|pi²?|ft|inch(?:es)?|in(?!\s?\d)|lbs?|oz|gal)(?![\p{L}²])|\d+(?:[.,]\d+)?\s?["″](?!\w)/giu;
const METRIC_NEAR_RE = /\d+(?:[.,]\d+)?\s?(?:cm|mm|m²|m2|m|kg|g|l|ml)(?![\p{L}])/iu;

/**
 * Imperial values left in prose WITHOUT a metric equivalent beside them. Dual units such as
 * "30 m² (323 pi²)" or "30 kg (66 lb)" are correct and are not reported; "Hauteur de 38,25 po"
 * is. `text` must already be tag-free.
 */
export function findImperialOnly(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPERIAL_RE)) {
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - 40), at + m[0].length + 40);
    if (METRIC_NEAR_RE.test(around)) continue;
    out.push(m[0].trim());
  }
  return [...new Set(out)];
}

// ── Missing accents ─────────────────────────────────────────────────────────────────────────
// Unaccented spellings a model sometimes emits for words that are always accented in French.
// Deliberately a short, high-precision list (every entry is wrong unaccented in any context).
const UNACCENTED: Array<[RegExp, string]> = [
  [/\bbebes?\b/i, "bébé"], [/\bsecurite\b/i, "sécurité"], [/\bresistan(?:t|te|ts|tes)\b/i, "résistant"],
  [/\becrans?\b/i, "écran"], [/\betageres?\b/i, "étagère"], [/\brembourre(?:e|s|es)?\b/i, "rembourré"],
  [/\breglables?\b/i, "réglable"], [/\betanches?\b/i, "étanche"], [/\bdecoratif(?:s|ve|ves)?\b/i, "décoratif"],
  [/\bexterieur(?:e|s|es)?\b/i, "extérieur"], [/\binterieur(?:e|s|es)?\b/i, "intérieur"],
  [/\bcreez\b/i, "créez"], [/\bpiece(?:s)?\b/i, "pièce"], [/\bgeneral(?:e|es|aux)?\b/i, "général"],
];

/** Accent-less French spellings found in `text`, as "found → expected" hints. */
export function findUnaccentedFrench(text: string): string[] {
  const out: string[] = [];
  for (const [re, fix] of UNACCENTED) {
    const m = text.match(re);
    if (m) out.push(`${m[0]} → ${fix}`);
  }
  return out;
}

// ── Tags ────────────────────────────────────────────────────────────────────────────────────
export const MIN_TAGS = 6;
