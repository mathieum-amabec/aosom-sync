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

// Mat 2026-11-19: "assure-toi que le titre des prochains reste court". 10 → 8: a product-type-first
// title ("Ensemble table et 4 chaises pour enfants") says everything a shopper scans for.
const MAX_TITLE_WORDS = 8;

/** Words that read as dangling when a title is cut right after them. */
const DANGLING = new Set([
  "de", "du", "des", "d'", "la", "le", "les", "l'", "un", "une", "pour", "avec", "et", "en", "à", "au", "aux", "sur",
  "sans", "ou", "the", "a", "an", "for", "with", "and", "of", "in", "on", "to", "without", "or",
]);

const PLACEHOLDER = (i: number) => `\u0001${i}\u0001`;

// "Lot de 4", "Ensemble de 6", "Set of 2": the piece count is the one fact a shopper must not lose
// from the title. Protected as ONE word, ahead of DIMENSION_RE (which would swallow the bare "4").
const QUANTITY_SRC = String.raw`(?:lot|ensemble|paquet|jeu|s[ée]rie|set|pack)\s+(?:de|d'|of)\s*\d+(?![\d.,]*\s*(?:cm|mm|m|kg|po|pi|in|ft))`;
const QUANTITY_ONLY_RE = new RegExp(`^${QUANTITY_SRC}$`, "iu");
// "5-8 personnes", "4 places": a capacity is ONE word too — cutting between the number and its noun left
// "Abri de pêche sur glace pop-up 5" (held by the judge as truncated, 2026-11-19).
const CAPACITY_SRC = String.raw`\d+(?:\s*[-–]\s*\d+)?\s+(?:personnes?|places?|pers\.?)(?![\p{L}])`;
const PROTECT_RE = new RegExp(`${QUANTITY_SRC}|${CAPACITY_SRC}|${DIMENSION_RE.source}`, "giu");

function protectDimensions(s: string): { text: string; dims: string[] } {
  const dims: string[] = [];
  const text = s.replace(PROTECT_RE, (m) => {
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

  const take = (list: string[], budget: number) => {
    const out: string[] = [];
    let n = 0;
    for (const w of list) {
      if (isSeparator(w)) { out.push(w); continue; }
      if (n >= budget) break;
      out.push(w);
      n++;
    }
    return { out, n, cut: out.length < list.length };
  };
  const trimTail = (list: string[]) => {
    while (list.length) {
      const last = list[list.length - 1].toLowerCase().replace(/[.,;:]+$/, "");
      if (isSeparator(last) || DANGLING.has(last) || /^\d+(?:[-–]\d+)?$/.test(last)) list.pop();
      else break;
    }
    return list;
  };
  const isQuantity = (w: string) => {
    const m = /^\u0001(\d+)\u0001$/.exec(w);
    return !!m && QUANTITY_ONLY_RE.test(dims[Number(m[1])] ?? "");
  };

  // A cut must never remove the piece count: "…similicuir — Lot de 4 chaises" used to become
  // "…similicuir — Lot" (the "4" fell past word 10, then the dangling "de" was dropped), leaving a
  // listing that no longer said how many chairs come in the set. Reserve one word for it and
  // shorten the words around it instead.
  const qtyIdx = words.findIndex(isQuantity);
  if (qtyIdx >= 0) {
    const before = words.slice(0, qtyIdx);
    const after = words.slice(qtyIdx + 1);
    const b = take(before, max - 1);
    const a = take(after, max - 1 - b.n);
    const hadSepBefore = before.length > 0 && isSeparator(before[before.length - 1]);
    const head = trimTail(b.out);
    if (hadSepBefore && head.length) head.push("—");
    const tail = trimTail(a.out);
    return restoreDimensions([...head, words[qtyIdx], ...tail].join(" "), dims).trim();
  }

  const { out: kept } = take(words, max);
  trimTail(kept);
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
const MIDDLE_COLOUR_RE = new RegExp(`\\s+[—–-]\\s*(?:${COLOUR_ALT})(?:\\s*(?:et|and|/|,)\\s*(?:${COLOUR_ALT}))*\\s*(?=[—–-]\\s)`, "i");
const INLINE_COLOUR_RE =new RegExp(`(?<![\\p{L}\\d])(?:${COLOUR_ALT})(?![\\p{L}\\d])`, "giu");

/**
 * Remove colour from a generated title. A trailing "— gris" segment is always removed. Colour
 * words inside the title are removed only when the product has several colours
 * (`multiColour`): there the colour is a variant choice, and naming one in the title is wrong
 * for the others. A single-colour product may keep "Sapin artificiel blanc", which is a
 * description of the thing, not a variant label.
 */
export function stripColourFromTitle(title: string, multiColour: boolean): string {
  // A dash-delimited colour-only segment in the MIDDLE ("… enfants — Jaune — Lot de 5") is a
  // variant label too: the trailing rule below only sees the very end of the title.
  let out = title.replace(MIDDLE_COLOUR_RE, " ").replace(TRAILING_COLOUR_RE, "");
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

/**
 * Metric label for a Shopify "Taille" option VALUE. Aosom writes sizes in inches / feet (`9.3" x 9.3" x 72.4"`,
 * "6 pi"); ~40 % of imports since 2026-10-20 reached the store that way. Same conversion as titles, plus the
 * `31.5"W x 15.7"D` form. A value that already carries a metric figure ("6 pi (183 cm)", Costway) is left alone,
 * and so are labels with no unit ("Lot de 4", "Grand").
 */
export function convertImperialSize(value: string, locale: "fr" | "en" = "fr", apostrophe: "in" | "ft" | null = null): string {
  // Already metric somewhere ("6 pi (183 cm)", "(13H x 96-130L x 7Wcm)").
  if (!value || /\d\s?(?:cm|mm|m)(?![\p{L}²])/iu.test(value) || /\d[A-Za-z]{0,2}cm\b/i.test(value)) return value;
  // Volumes and weights are not lengths ("1,1 pi³", "50 lb"), nor is a fraction of an inch ("1/2" x 100 pi"): left to a human.
  if (/[²³]|\b(?:pi|ft)\s?[23]\b|\b(?:gal|lbs?|oz)\b|\d\/\d/iu.test(value)) return value;
  const s = value.replace(/[″”]|''/g, '"');
  // number + optional unit (inch mark, po, in, pi, ft). "3 in 1" is a feature, not 3 inches.
  const TOKEN = /(\d+(?:[.,]\d+)?)(\s*(?:"|'|pouces?(?![\p{L}])|po(?![\p{L}])|in(?![\p{L}]|\s*\d)|pieds?(?![\p{L}])|pi(?![\p{L}])|feet(?![\p{L}])|ft(?![\p{L}])))?/giu;
  const toks = [...s.matchAll(TOKEN)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, n: num(m[1]), unit: (m[2] ?? "").trim().toLowerCase(), cm: 0, own: false }));
  // Resolve each token's unit: its own mark, else the next token's when only a separator lies between ("8 x 3 x 1 pi", "5 x 7 pi").
  const GAP = /^\s*[WDHLwdhl]?\s*(?:[x×*]|-|–|\/)\s*(?:Dia\.?|[Φφ⌀ØФ])?\s*$/u;
  const kind: ("in" | "ft" | null)[] = toks.map(() => null);
  for (let i = toks.length - 1; i >= 0; i--) {
    const u = toks[i].unit;
    if (u === "'") { if (!apostrophe) return value; kind[i] = apostrophe; toks[i].own = true; }
    else if (u) { kind[i] = /^(?:pi|pieds?|ft|feet)$/.test(u) ? "ft" : "in"; toks[i].own = true; }
    else if (i + 1 < toks.length && kind[i + 1] && GAP.test(s.slice(toks[i].end, toks[i + 1].start))) kind[i] = kind[i + 1];
  }
  if (!toks.some((t) => t.own)) return value;
  const cms = toks.map((t, i) => (kind[i] ? t.n * (kind[i] === "ft" ? CM_PER_FOOT : CM_PER_INCH) : NaN));
  // A figure under half a centimetre ("0.03" D") is a thickness, not a size label worth rewriting.
  if (cms.some((c) => Number.isFinite(c) && c < 0.5)) return value;
  const metres = Math.max(...cms.filter(Number.isFinite)) >= 300;
  let out = "", pos = 0;
  toks.forEach((t, i) => {
    out += s.slice(pos, t.start);
    pos = t.end;
    if (!kind[i]) { out += s.slice(t.start, t.end); return; }
    out += metres ? fmt(cms[i] / 100, locale, 1) : fmt(cms[i], locale);
    // The unit goes after the last figure of a chain; "cm" between two figures of one chain is dropped.
    const next = toks[i + 1];
    const chained = next && kind[i + 1] && /^\s*(?:[x×*]|-|–|\/)\s*$/u.test(s.slice(t.end, next.start));
    if (t.own && !chained) out += metres ? " m" : " cm";
    if (t.own && !chained && /^[A-Za-z]/.test(s.slice(t.end))) out += " ";
  });
  return (out + s.slice(pos)).replace(/(\d)\s*[x×*]\s*(?=\d)/g, "$1 x ").replace(/(\d)\s+-(?=\d)/g, "$1-");
}

const IMPERIAL_RE =/\d+(?:[.,]\d+)?\s?(?:po|pi²?|ft|inch(?:es)?|in(?!\s?\d)|lbs?|oz|gal)(?![\p{L}²])|\d+(?:[.,]\d+)?\s?["″](?!\w)/giu;
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

// ── Known French slips ─────────────────────────────────────────────────────────────────────
// Misspellings / bad calques the content models keep producing and the judge then (rightly) holds the product for
// (2026-11-19 held list: "Chemalet" for chevalet, "Caissier de classeur" for classeur, "Caissson", "méelamine", "Quinquailles").
// Repaired in code like the title units: deterministic, high-precision, every entry is wrong in any context.
const FR_SLIPS: Array<[RegExp, string]> = [
  [/\bcaissiers?\s+(?:de|à|pour)\s+(classeurs?)\b/gi, "$1"],
  [/\bcaissiers?\b/gi, "caisson"],
  [/\bcaiss{2,}on(s?)\b/gi, "caisson$1"],
  [/\bch[ae]m[ae]l(?:et|eau)(s|x)?\b/gi, "chevalet$1"],
  [/\bchevelets?\b/gi, "chevalet"],
  [/\bméelamine\b/gi, "mélamine"],
  [/\bquinquail\p{L}*/giu, "quincaillerie"],
];

/** Fix known French misspellings in generated copy (title, description, SEO fields). Keeps the first-letter case. */
export function repairFrenchSlips(text: string): string {
  let out = text;
  for (const [re, to] of FR_SLIPS) {
    out = out.replace(re, (m: string, g1?: unknown) => {
      const rep = to.replace("$1", typeof g1 === "string" ? g1 : "");
      return /^[A-ZÀ-Ý]/.test(m) ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep;
    });
  }
  return out;
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

// ── Piece count ("Set of 4") ────────────────────────────────────────────────────────────────
// A set's size is what the shopper is buying. The chairs imported 2026-10-05 had a title ending
// "— Lot" and an intro that never said how many chairs come in the box.

/** Number of pieces a supplier title / size label announces ("Set of 4", "6 Pack", "4 Pieces"), else null. */
export function inferPieceCount(...texts: Array<string | null | undefined>): number | null {
  for (const t of texts) {
    if (!t) continue;
    // "Dollhouse with 8 PCS Accessories", "Play Kitchen … 12PCs Accessories": the number counts the accessories of ONE
    // product, not products sold together — it must never become "Lot de 8" (judge held both, 2026-11-19).
    const own = t.replace(/\b\d{1,2}[\s-]*(?:pcs?|pieces?)\s+(?:of\s+)?(?:accessor\w*|toys?|play\s*food|foods?)/gi, " ");
    const m =
      /\b(?:set|pack|lot|bundle)\s+of\s+(\d{1,2})\b/i.exec(own) ||
      /\b(\d{1,2})[\s-]*(?:pcs?|pieces?|pack)\b/i.exec(own);
    const n = m ? Number(m[1]) : NaN;
    if (n >= 2 && n <= 24) return n;
  }
  return null;
}

const NUMBER_WORDS: Record<number, string[]> = {
  2: ["deux", "two", "pair", "paire"], 3: ["trois", "three"], 4: ["quatre", "four"], 5: ["cinq", "five"],
  6: ["six"], 7: ["sept", "seven"], 8: ["huit", "eight"], 9: ["neuf", "nine"], 10: ["dix", "ten"],
  11: ["onze", "eleven"], 12: ["douze", "twelve", "dozen"],
};

/** True when `text` states the piece count, as digits or as a word. */
export function mentionsPieceCount(text: string, n: number): boolean {
  if (new RegExp(String.raw`(?<![\d.,])${n}(?![\d.,]*\s*(?:cm|mm|kg|po|pi|in|ft|lb))`, "i").test(text)) return true;
  return (NUMBER_WORDS[n] ?? []).some((w) => new RegExp(String.raw`\b${w}\b`, "i").test(text));
}

/** Append "— Lot de N" / "— Set of N" when a generated title does not carry the piece count. */
export function ensureTitlePieceCount(title: string, n: number | null, locale: "fr" | "en"): string {
  // The model sometimes states the count twice ("Ensemble de trois haltères — Lot de 3"): the judge holds those
  // as repetition. When the part before a trailing "— Lot de N" already carries N, the tail goes.
  const dup = /^(.*\S)\s*[—–-]\s*(?:Lot de|Set of)\s+(\d{1,2})\s*$/iu.exec(title);
  if (dup && /\b(?:ensemble|jeu|lot|paquet|set|pack)\s+(?:de|d'|of)\s*\p{L}*\s*\d*/iu.test(dup[1]) && mentionsPieceCount(dup[1], Number(dup[2]))) return dup[1].trim();
  if (!n || mentionsPieceCount(title, n)) return title;
  // "Ensemble table et 4 chaises" already spells out what the set contains: a "5-piece" feed count
  // (table + 4 chairs) must not become a false "Lot de 5" multi-pack.
  if (/\b(?:et|avec|and|with)\s+\d{1,2}\s+(?!cm\b|mm\b|m\b|kg\b|po\b|pi\b|in\b|ft\b|lb)\p{L}{3,}/iu.test(title)) return title;
  const tail = locale === "fr" ? `Lot de ${n}` : `Set of ${n}`;
  return capTitleWords(`${title.replace(/[\s—–-]+$/, "")} — ${tail}`);
}
