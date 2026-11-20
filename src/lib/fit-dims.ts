/**
 * "Est-ce que ça va entrer chez moi ?" — product + box dimensions for the PDP fit checker.
 *
 * The Aosom feed gives each SKU its assembled size (Length/Width/Height, mostly "47.80 in", sometimes "ft" or "cm")
 * and its shipping boxes (Box_Size, always cm, one or more boxes joined by "|"). We store them, converted to cm, in
 * one product metafield `custom.lc_dims` (json) keyed by variant SKU, so the theme can answer per variant without
 * any API call. Aosom's L × W × H reads as width × depth × height (its own copy writes "(L x P x H)").
 */

export const FIT_DIMS_NAMESPACE = "custom";
export const FIT_DIMS_KEY = "lc_dims";

/** cm, one decimal: [width, depth, height]. */
export type Cm3 = [number, number, number];

export interface FitDimsEntry {
  /** Assembled size in cm, [width, depth, height]. */
  p: Cm3;
  /** Shipping boxes in cm, each sorted smallest → largest (orientation doesn't matter for a box). */
  b?: Cm3[];
}

export interface FitDims {
  v: 1;
  s: Record<string, FitDimsEntry>;
}

const TO_CM: Record<string, number> = { in: 2.54, inch: 2.54, inches: 2.54, '"': 2.54, ft: 30.48, cm: 1, mm: 0.1, m: 100 };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** "47.80 in" → 121.4 (cm). Unknown unit or a non-positive number → null. A bare number is read as inches (feed default). */
export function lengthToCm(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const m = String(raw).trim().toLowerCase().replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*(in|inch|inches|"|ft|cm|mm|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  return round1(n * TO_CM[m[2] ?? "in"]);
}

/** "88.00x25.00x55.00 cm|85.70x56.00x15.50 cm" → [[25,55,88],[15.5,56,85.7]]. Malformed boxes are skipped. */
export function parseBoxSizes(raw: string | null | undefined): Cm3[] {
  if (!raw) return [];
  const out: Cm3[] = [];
  for (const part of raw.split("|")) {
    const m = part.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(cm|in)?$/);
    if (!m) continue;
    const k = m[4] === "in" ? 2.54 : 1;
    const dims = [m[1], m[2], m[3]].map((x) => round1(parseFloat(x) * k));
    if (dims.some((d) => !(d > 0))) continue;
    out.push(dims.sort((a, b) => a - b) as Cm3);
  }
  return out;
}

export interface FitDimsSource {
  sku: string;
  /** Raw feed strings ("47.80 in") or already-parsed numbers in inches (AosomProduct.dimensions). */
  length: string | number;
  width: string | number;
  height: string | number;
  boxSize?: string;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
/** A dimension letter some labels put next to a number: "65 l × 72 P × 117 H cm", "347 cm (L) x 160 cm (l)". */
const LET = String.raw`(?:\(?[LlPpHhWwDd]\)?(?![\p{L}])\s*)?`;
const UNIT = String.raw`(cm|m(?![\p{L}\d²³])|"|”|″|po(?![\p{L}])|in(?![\p{L}])|pi(?![\p{L}])|pieds?(?![\p{L}])|ft(?![\p{L}]))`;
const TOK = String.raw`${NUM}\s*${LET}(?:${UNIT}\s*)?${LET}`;
/** "190x190x200cm", "3 x 3 m", "6x3x2m", "65 l × 72 P × 117 H cm", `30.7" x 32.7" x 39.8"`, "10 pi x 12 pi": a size stated in a title or option value.
 *  A bare apostrophe is NOT feet: Aosom types it for inches too ("18.5x22'" is a 47 cm stool seat). */
const SIZE_CUE = new RegExp(String.raw`${TOK}\s*[x×]\s*${TOK}(?:\s*[x×]\s*${TOK})?`, "giu");

const CUE_UNIT_CM: Record<string, number> = { cm: 1, m: 100, '"': 2.54, "”": 2.54, "″": 2.54, po: 2.54, in: 2.54, pi: 30.48, pied: 30.48, pieds: 30.48, ft: 30.48 };

/** Every size (2 or 3 numbers, in cm) a piece of text states, metric, inches or feet. A size with no unit anywhere is ignored. */
export function metricCues(text: string | null | undefined): number[][] {
  const out: number[][] = [];
  const clean = (text || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  for (const m of clean.matchAll(SIZE_CUE)) {
    const nums = [m[1], m[3], m[5]];
    const units = [m[2], m[4], m[6]];
    const last = [...units].reverse().find(Boolean);
    if (!last) continue;
    const vals: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (nums[i] == null) continue;
      const k = CUE_UNIT_CM[(units[i] ?? last).toLowerCase()];
      if (!k) { vals.length = 0; break; }
      vals.push(round1(parseFloat(nums[i].replace(",", ".")) * k));
    }
    // A number under 5 cm is a quantity ("Lot de 2 x 140 x 240 cm") or a part, not a side of the item.
    if (vals.length >= 2 && vals.every((n) => n >= 5 && n < 3000)) out.push(vals);
  }
  return out;
}

const cueClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(3, b * 0.06);
const cueAgrees = (p: Cm3, cue: number[]) => cue.every((c) => p.some((d) => cueClose(d, c)));

/**
 * Unit slips seen in the Aosom feed, by the label the value carried: an "…in" value that is really feet (×12), really cm
 * (÷2.54) or converted to inches twice (×2.54: a 43 cm bar stool listed as "6.60 in"); a "…cm" value that is really
 * inches (×2.54). A "ft" label is trusted; a "cm" label is never read as feet.
 */
export type FeedUnit = "in" | "cm" | "ft";
const SLIPS_BY_UNIT: Record<FeedUnit, readonly number[]> = { in: [12, 1 / 2.54, 2.54], cm: [2.54], ft: [] };

/** The unit a raw feed length carries ("47.80 in", "10 ft", "120 cm"); a bare number is read as inches, like lengthToCm. */
export function feedUnitOf(raw: string | number | null | undefined): FeedUnit {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/(cm|mm|\d\s*m)$/.test(s)) return "cm";
  if (/ft$/.test(s)) return "ft";
  return "in";
}

const scale3 = (p: Cm3, k: number) => p.map((x) => round1(x * k)) as Cm3;

/**
 * The feed's unit label is not reliable ("9.10 in" for a 9.1 FOOT shed → the page said 23 × 16 × 16 cm, 2026-11-19).
 * A size that contradicts the product's own metric size in its title / size labels is re-read with each known slip;
 * the one that matches the text wins, and two that match (ambiguous) drop the size so the checker hides instead of
 * guessing. With nothing to compare to, the parcel is the witness: an assembled item under half the length of its own
 * biggest box, that becomes a sensible 0.55–3× of that box when read as feet (or as inches for a "cm" label), took the
 * wrong unit. Inflatables and tarps pack far smaller than they stand, so the rule only touches a clearly too-small
 * item, only up to 4.5 m, and only when exactly one reading fits.
 * Returns null = drop this SKU's size.
 */
export function reconcileUnits(e: FitDimsEntry, cues: number[][], unit: FeedUnit = "in"): { entry: FitDimsEntry; fix: number | null } | null {
  if (cues.some((c) => cueAgrees(e.p, c))) return { entry: e, fix: null };
  if (cues.length) {
    const hits = SLIPS_BY_UNIT[unit].filter((k) => cues.some((c) => cueAgrees(scale3(e.p, k), c)));
    // A reading that makes the item more than 8× its own biggest parcel is not a unit slip, whatever the text says.
    const boxTop = e.b?.length ? Math.max(...e.b.map((b) => Math.max(...b))) : 0;
    const sane = hits.filter((k) => !(boxTop > 0 && (Math.max(...e.p) * k) / boxTop > 8));
    if (sane.length === 1 && hits.length === 1) return { entry: { ...e, p: scale3(e.p, sane[0]) }, fix: sane[0] };
    if (hits.length > 1) return null;
  }
  const boxMax = e.b?.length ? Math.max(...e.b.map((b) => Math.max(...b))) : 0;
  if (boxMax > 0) {
    const a = Math.max(...e.p);
    if (a / boxMax < 0.5) {
      const fits = (unit === "in" ? [12, 2.54] : unit === "cm" ? [2.54] : []).filter((k) => {
        const r = (a * k) / boxMax;
        return r >= 0.55 && r <= 3 && a * k <= 450;
      });
      if (fits.length === 1) return { entry: { ...e, p: scale3(e.p, fits[0]) }, fix: fits[0] };
    }
  }
  return { entry: e, fix: null };
}

const near3 = (a: Cm3, b: Cm3) => {
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => Math.abs(v - y[i]) <= Math.max(1.5, y[i] * 0.04));
};
/** How far an entry's size sits from "about 1.3× its biggest box" (log scale); null without a parcel. */
function parcelScore(e: FitDimsEntry, p: Cm3 = e.p): number | null {
  const boxMax = e.b?.length ? Math.max(...e.b.map((b) => Math.max(...b))) : 0;
  return boxMax > 0 ? Math.abs(Math.log(Math.max(...p) / boxMax / 1.3)) : null;
}

/**
 * Colours/sizes of ONE product do not differ by exactly ×12, ×2.54 or ÷2.54. When two SKUs' sizes do, one of them carries a
 * unit slip; the one whose size sits further from its own parcel is rescaled onto the other (both need a parcel, and the
 * rescaled value must fit its parcel better). Audit 2026-11-19: a lounger-like armchair read 31 × 33 × 40 cm in one colour
 * and 78 × 83 × 101 cm in the other.
 */
export function harmonizeSiblings(s: Record<string, FitDimsEntry>): void {
  const skus = Object.keys(s);
  const fixes = new Map<string, Cm3>();
  for (const a of skus) for (const b of skus) {
    if (a === b || fixes.has(a) || fixes.has(b)) continue;
    const ea = s[a], eb = s[b];
    if (near3(ea.p, eb.p)) continue;
    for (const k of [12, 1 / 2.54, 2.54]) {
      if (!near3(scale3(ea.p, k), eb.p)) continue;
      const sa = parcelScore(ea), sb = parcelScore(eb);
      if (sa == null || sb == null) break;
      const [victim, to] = sa > sb ? [a, scale3(ea.p, k)] : [b, scale3(eb.p, 1 / k)];
      const before = victim === a ? sa : sb;
      const after = parcelScore(s[victim], to);
      if (after != null && after < before) fixes.set(victim, to);
      break;
    }
  }
  for (const [sku, p] of fixes) s[sku] = { ...s[sku], p };
}

/**
 * One entry per SKU that has a complete assembled size. Returns null when no SKU has one (nothing to store).
 * `labelText` (title + size labels) lets reconcileUnits catch a mislabelled unit; descriptions are NOT passed: they list
 * parts and bases ("base 13 x 13 cm") that would match a wrong reading by coincidence.
 */
export function buildFitDims(sources: FitDimsSource[], labelText?: string | null): FitDims | null {
  const s: Record<string, FitDimsEntry> = {};
  const cues = metricCues(labelText);
  for (const src of sources) {
    const w = lengthToCm(src.length), d = lengthToCm(src.width), h = lengthToCm(src.height);
    if (w == null || d == null || h == null || !src.sku) continue;
    const entry: FitDimsEntry = { p: [w, d, h] };
    const boxes = parseBoxSizes(src.boxSize);
    if (boxes.length) entry.b = boxes;
    const rec = reconcileUnits(entry, cues, feedUnitOf(src.length));
    if (!rec) continue;
    s[src.sku.trim()] = rec.entry;
  }
  harmonizeSiblings(s);
  return Object.keys(s).length ? { v: 1, s } : null;
}

const CM_TRIPLE = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*cm/i;

/** First "A x B x C cm" in a (plain-text or HTML) description, or null. */
export function parseCmTriple(text: string | null | undefined): Cm3 | null {
  const m = (text || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").match(CM_TRIPLE);
  if (!m) return null;
  return [m[1], m[2], m[3]].map((x) => round1(parseFloat(x.replace(",", ".")))) as Cm3;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(3, b * 0.06);

/**
 * Does the feed size match the size the product page already states? Order-insensitive (a page may list depth first).
 * Audit 2026-10-20: 1405 of 1459 pages agree; the 54 others are wrong on one side or the other (a "47.2 cm" feed
 * value that is really inches, a 160 cm bench described as 61 cm), so the caller drops those products rather than
 * show a measurement that contradicts the page.
 */
export function sizesAgree(feed: Cm3, page: Cm3): boolean {
  const a = [...feed].sort((x, y) => x - y), b = [...page].sort((x, y) => x - y);
  return a.every((x, i) => close(x, b[i]));
}

/** `dims` unless the page states a size that no variant matches (then null: store nothing, the checker stays hidden). */
export function checkAgainstPage(dims: FitDims | null, pageText: string | null | undefined): FitDims | null {
  if (!dims) return null;
  const page = parseCmTriple(pageText);
  if (!page) return dims;
  return Object.values(dims.s).some((e) => sizesAgree(e.p, page)) ? dims : null;
}

const SUP_UNIT = String.raw`(”|"|''|″|inch(?:es)?\b|in\b|cm\b|mm\b)`;
const SUP_NUM = String.raw`(\d+(?:\.\d+)?)`;
const SUP_TRIPLE = new RegExp(
  `${SUP_NUM}\\s*${SUP_UNIT}?\\s*[x×X*]\\s*${SUP_NUM}\\s*${SUP_UNIT}?\\s*[x×X*]\\s*${SUP_NUM}\\s*${SUP_UNIT}?`,
  "gi",
);
/** Words that, right before a triple, mean "this is the assembled item". */
const SUP_LABEL = /dimension|overall|assembled|product size|item size/i;
/** Words that, just before a triple, mean "this is a part" (drawer, mirror…). */
const SUP_PART = /inner|drawer|top|mirror|flowerpot|seat|opening|stool/i;
/** Words anywhere in the label that mean "this is the parcel". */
const SUP_PARCEL = /package|packing|box|carton|shipping/i;

/**
 * Assembled size from a SUPPLIER description (Costway feed bodies: "Overall Dimension: 94.5” x 32.5” x 32.5” (L x W x H)"),
 * in cm as [width, depth, height] = the supplier's L × W × H. Only a triple labelled as the item's size and not as a
 * part or the parcel is accepted — anything less certain returns null so the checker stays hidden rather than guess.
 * Unitless or inch-marked numbers are inches (the feed's convention); cm / mm are converted.
 * Audit 2026-11-12: 288 of the 361 Costway products without sizes pass; a hand check of a sample found no wrong pick.
 */
export function extractSupplierSize(html: string | null | undefined): Cm3 | null {
  const text = (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  for (const seg of text.split(/(?<=[.●|;])\s+|●/)) {
    for (const m of seg.matchAll(SUP_TRIPLE)) {
      const at = m.index ?? 0;
      const before = seg.slice(Math.max(0, at - 45), at);
      const label = [...before.matchAll(new RegExp(SUP_LABEL.source, "gi"))].pop();
      if (!label) continue;
      // Only what qualifies THIS label counts: "Package Dimensions:" / "Box size …" are the parcel, but an earlier
      // "Shipped in 3 boxes:" heading is not.
      const qualifier = before.slice(Math.max(0, (label.index ?? 0) - 14));
      if (SUP_PARCEL.test(qualifier) || SUP_PART.test(before.slice(-25))) continue;
      const unit = (m[6] || m[4] || m[2] || '"').toLowerCase();
      const k = unit.startsWith("cm") ? 1 : unit.startsWith("mm") ? 0.1 : 2.54;
      const dims = [m[1], m[3], m[5]].map((x) => round1(parseFloat(x) * k)) as Cm3;
      if (dims.every((d) => d >= 2 && d <= 500)) return dims;
    }
  }
  return null;
}

/** Same JSON the theme reads; stable key order so a re-run only rewrites products whose dimensions changed. */
export function serializeFitDims(d: FitDims): string {
  const s: Record<string, FitDimsEntry> = {};
  for (const k of Object.keys(d.s).sort()) s[k] = d.s[k];
  return JSON.stringify({ v: 1, s });
}
