/**
 * Costway supplier feed — fetch + parse.
 *
 * The feed is a Shopify-product-export-shaped CSV, but it is NOT RFC 4180: Costway strips
 * commas out of every value (they become double spaces) and never quotes a field, so raw
 * `"` characters (inch marks like `73"`, `style="…"` in the HTML) sit unescaped inside
 * values. A standard CSV parser treats those `"` as quote delimiters and merges rows —
 * Costway's own docs warn about "illegal quoting". Every line has exactly one field per
 * header, so the right parser is a plain split on `,`; a line with the wrong field count
 * is skipped and counted, never half-imported.
 *
 * One row = one variant. `Item No` groups a product's variants (the Variant SKU is
 * `<Item No>_<suffix>`), `Option1 Value` is the colour. The "1=In Stock|0=OOS" flag is the
 * availability Costway tells dropshippers to trust (not the CA/US inventory columns).
 */
import { COSTWAY } from "@/lib/config";

export interface CostwayVariant {
  sku: string;
  itemNo: string;
  handle: string;
  title: string;
  bodyHtml: string;
  /** Full path, e.g. "Outdoor > Outdoor Shades > Outdoor Umbrella Bases". */
  category: string;
  /** First segment of `category`, e.g. "Outdoor". */
  topCategory: string;
  productType: string;
  color: string;
  productUrl: string;
  images: string[];
  inStock: boolean;
  qty: number;
  usQty: number | null;
  caQty: number | null;
  /** Retail price Costway requires us to sell at (the dropship discount applies to it). */
  price: number | null;
  /** Advertised-price floor: promotions must never show a price under this. */
  priceDrop: number | null;
  compareAtPrice: number | null;
  /** Costway merchandising tag: "Drop Price" | "Clearance" | "Bestseller" | "New Arrivals" | … */
  promoTag: string;
}

export interface ParseResult {
  variants: CostwayVariant[];
  /** Data lines seen (excluding header and blank lines). */
  totalRows: number;
  /** Lines whose field count didn't match the header. */
  malformedRows: number;
  /** Lines missing a SKU, Item No or title. */
  incompleteRows: number;
  /** Lines whose SKU already appeared earlier in the file (first one wins). */
  duplicateRows: number;
}

const COL = {
  handle: "Handle",
  title: "Title",
  itemNo: "Item No",
  url: "Item Link",
  body: "Body (HTML)",
  category: "Category",
  type: "Type",
  color: "Option1 Value",
  sku: "Variant SKU",
  inStock: "1=In Stock|0=OOS",
  qty: "Variant Inventory Qty",
  usQty: "US Inventory",
  caQty: "Canadian inventory",
  price: "Variant Price",
  priceDrop: "Price Drop",
  compareAt: "Variant Compare At Price",
  promoTag: "Tag",
} as const;

const IMAGE_SRC = "Image Src";
const IMAGE_POSITION = "Image Position";

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse the raw Costway CSV text. Throws only when the header is unusable. */
export function parseCostwayCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").replace(/^﻿/, "").split(",").map((h) => h.trim());

  const idx = {} as Record<keyof typeof COL, number>;
  const missing: string[] = [];
  for (const [key, name] of Object.entries(COL) as [keyof typeof COL, string][]) {
    idx[key] = header.indexOf(name);
    if (idx[key] === -1) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`Costway CSV header is missing column(s): ${missing.join(", ")}`);
  }
  // The feed repeats "Image Src" / "Image Position" pairs (10 of them).
  const imageCols: { src: number; pos: number }[] = [];
  header.forEach((h, i) => {
    if (h === IMAGE_SRC) imageCols.push({ src: i, pos: header[i + 1] === IMAGE_POSITION ? i + 1 : -1 });
  });

  const result: ParseResult = { variants: [], totalRows: 0, malformedRows: 0, incompleteRows: 0, duplicateRows: 0 };
  const seen = new Set<string>();

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;
    result.totalRows++;
    const f = line.split(",");
    if (f.length !== header.length) {
      result.malformedRows++;
      continue;
    }
    const get = (k: keyof typeof COL) => (f[idx[k]] ?? "").trim();
    const sku = get("sku");
    const itemNo = get("itemNo");
    const title = get("title");
    if (!sku || !itemNo || !title) {
      result.incompleteRows++;
      continue;
    }
    if (seen.has(sku)) {
      result.duplicateRows++;
      continue;
    }
    seen.add(sku);

    const images = imageCols
      .map((c, order) => ({ src: (f[c.src] ?? "").trim(), pos: c.pos >= 0 ? num(f[c.pos]) ?? 999 : 999, order }))
      .filter((im) => /^https?:\/\//.test(im.src))
      .sort((a, b) => a.pos - b.pos || a.order - b.order)
      .map((im) => im.src)
      .filter((src, i, arr) => arr.indexOf(src) === i);

    const category = get("category");
    result.variants.push({
      sku,
      itemNo,
      handle: get("handle"),
      title,
      bodyHtml: get("body"),
      category,
      topCategory: category.split(">")[0].trim(),
      productType: get("type"),
      color: get("color"),
      productUrl: get("url"),
      images,
      inStock: get("inStock") === "1",
      qty: Math.max(0, Math.trunc(num(get("qty")) ?? 0)),
      usQty: num(get("usQty")),
      caQty: num(get("caQty")),
      price: num(get("price")),
      priceDrop: num(get("priceDrop")),
      compareAtPrice: num(get("compareAt")),
      promoTag: get("promoTag"),
    });
  }
  return result;
}

/**
 * Sanity checks on a downloaded feed before it may touch the DB. A truncated download or
 * an HTML error page must never be read as "Costway discontinued half its catalogue".
 */
export function validateCostwayFeed(parsed: ParseResult, previousRowCount: number | null): void {
  const rows = parsed.variants.length;
  if (rows < COSTWAY.MIN_ROWS_ABSOLUTE) {
    throw new Error(`Costway feed has only ${rows} usable rows (min ${COSTWAY.MIN_ROWS_ABSOLUTE})`);
  }
  if (previousRowCount && previousRowCount > 0) {
    const floor = Math.floor(previousRowCount * COSTWAY.MIN_ROWS_RATIO);
    if (rows < floor) {
      throw new Error(
        `Costway feed has ${rows} rows, under ${Math.round(COSTWAY.MIN_ROWS_RATIO * 100)}% of the last ` +
          `good sync (${previousRowCount}) — looks truncated`,
      );
    }
  }
}

/** Download the raw feed text. */
export async function fetchCostwayCsvText(): Promise<string> {
  const res = await fetch(COSTWAY.CSV_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(COSTWAY.FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Costway feed HTTP ${res.status}`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(`Costway feed looks like HTML, not CSV (first chars: ${text.slice(0, 60)})`);
  }
  return text;
}
