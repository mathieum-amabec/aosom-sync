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

/** One entry per SKU that has a complete assembled size. Returns null when no SKU has one (nothing to store). */
export function buildFitDims(sources: FitDimsSource[]): FitDims | null {
  const s: Record<string, FitDimsEntry> = {};
  for (const src of sources) {
    const w = lengthToCm(src.length), d = lengthToCm(src.width), h = lengthToCm(src.height);
    if (w == null || d == null || h == null || !src.sku) continue;
    const entry: FitDimsEntry = { p: [w, d, h] };
    const boxes = parseBoxSizes(src.boxSize);
    if (boxes.length) entry.b = boxes;
    s[src.sku.trim()] = entry;
  }
  return Object.keys(s).length ? { v: 1, s } : null;
}

const CM_TRIPLE = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*cm/i;

/** First "A x B x C cm" in a (plain-text or HTML) description, or null. */
export function parseCmTriple(text: string | null | undefined): Cm3 | null {
  const m = (text || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").match(CM_TRIPLE);
  if (!m) return null;
  return [m[1], m[2], m[3]].map((x) => round1(parseFloat(x.replace(",", ".")))) as Cm3;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1.5, b * 0.03);

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
