import type {
  AosomProduct,
  AosomMergedProduct,
  AosomVariant,
} from "@/types/aosom";

/**
 * French color map ported from reference aosom-shopify/merger.js.
 * 2-letter SKU suffix → French color name for Quebec market.
 */
export const COLOR_MAP: Record<string, string> = {
  BK: "Noir",
  CG: "Gris foncé",
  DR: "Brun foncé",
  GN: "Vert",
  LG: "Gris pâle",
  YG: "Vert pâle",
  SR: "Argent",
  CW: "Crème",
  TK: "Gris charbon",
  GY: "Gris",
  BU: "Bleu",
  BN: "Brun",
  BG: "Beige",
  DB: "Bleu foncé",
  GG: "Vert forêt",
  KK: "Kaki",
  WN: "Noyer",
  WT: "Blanc",
  RD: "Rouge",
  PK: "Rose",
  OG: "Orange",
  NT: "Naturel",
  CF: "Café",
};

/**
 * Parse a SKU into base and French color.
 * Algorithm: check last 2 chars against COLOR_MAP. If match and base >= 3 chars, split.
 */
export function parseSku(sku: string): { base: string; colorCode: string | null; color: string | null } {
  if (sku.length <= 4) return { base: sku, colorCode: null, color: null };
  const suffix = sku.slice(-2);
  if (COLOR_MAP[suffix]) {
    return { base: sku.slice(0, -2), colorCode: suffix, color: COLOR_MAP[suffix] };
  }
  return { base: sku, colorCode: null, color: null };
}

// Color words for title stripping (FR + EN)
const COLOR_WORDS = [
  ...Object.values(COLOR_MAP),
  "noir", "vert", "gris", "brun", "bleu", "argent", "crème", "beige", "kaki", "noyer",
  "gris foncé", "gris pâle", "gris charbon", "vert pâle", "vert forêt",
  "brun foncé", "bleu foncé", "blanc crème",
  "green", "black", "silver", "grey", "dark grey", "light grey", "charcoal",
  "dark brown", "light green", "cream", "blue", "brown", "white", "red",
  "pink", "orange", "natural", "beige", "walnut",
];

/**
 * Strip color from the end of a title.
 * Ported from reference aosom-shopify/merger.js:87-104.
 */
export function stripColorFromTitle(title: string): string {
  let cleaned = title;
  for (const c of COLOR_WORDS) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`[,\\s]*[-–]?\\s*${escaped}\\s*$`, "i");
    cleaned = cleaned.replace(re, "");
  }
  return cleaned.trim();
}

/**
 * Group individual CSV rows into merged products.
 * Priority: PSIN field → parseSku() fallback.
 */
export function mergeVariants(products: AosomProduct[]): AosomMergedProduct[] {
  const groups = new Map<string, AosomProduct[]>();

  for (const product of products) {
    const key = getGroupKey(product);
    const existing = groups.get(key);
    if (existing) {
      existing.push(product);
    } else {
      groups.set(key, [product]);
    }
  }

  const merged: AosomMergedProduct[] = [];

  for (const [groupKey, variants] of groups) {
    const primary = variants[0];

    const allImages: string[] = [];
    for (const v of variants) {
      for (const img of v.images) {
        if (!allImages.includes(img)) allImages.push(img);
      }
    }

    const cleanName = stripColorFromTitle(
      cleanProductName(primary.name, variants)
    );

    merged.push({
      groupKey,
      name: cleanName,
      brand: primary.brand,
      productType: primary.productType,
      category: primary.category,
      description: primary.description,
      shortDescription: primary.shortDescription,
      material: primary.material,
      images: allImages,
      video: primary.video,
      pdf: primary.pdf,
      variants: variants.map(toVariant),
    });
  }

  return merged;
}

function toVariant(p: AosomProduct): AosomVariant {
  // Use French color name from COLOR_MAP if available
  const { color: frColor } = parseSku(p.sku);
  return {
    sku: p.sku,
    price: p.price,
    qty: p.qty,
    color: frColor || p.color,
    size: p.size,
    gtin: p.gtin,
    weight: p.weight,
    dimensions: p.dimensions,
    images: p.images,
    estimatedArrival: p.estimatedArrival,
    outOfStockExpected: p.outOfStockExpected,
    packageNum: p.packageNum,
    boxSize: p.boxSize,
    boxWeight: p.boxWeight,
  };
}

function getGroupKey(product: AosomProduct): string {
  if (product.psin && product.psin.trim() !== "") {
    return product.psin.trim();
  }
  return parseSku(product.sku).base;
}

function cleanProductName(name: string, variants: AosomProduct[]): string {
  if (variants.length <= 1) return name;
  const uniqueNames = new Set(variants.map((v) => v.name));
  if (uniqueNames.size === 1) return name;
  const names = variants.map((v) => v.name);
  let common = names[0];
  for (let i = 1; i < names.length; i++) {
    while (!names[i].startsWith(common)) {
      common = common.slice(0, -1);
    }
  }
  common = common.replace(/[\s,\-–]+$/, "").trim();
  return common || name;
}

export function buildSkuIndex(products: AosomProduct[]): Map<string, AosomProduct> {
  const map = new Map<string, AosomProduct>();
  for (const p of products) map.set(p.sku, p);
  return map;
}

// ─── Image selection for new-product imports (Étape 1) ─────────────────
// Pure and URL-only — never does network I/O. Applied ONLY on the import/create
// path (see queueForImport), never inside mergeVariants: mergeVariants also feeds
// the daily sync/diff path (job1-sync → computeDiffs → applyToShopify), so
// filtering there would re-image products that are already live. Re-touching
// existing products is Étape 4, explicitly out of scope here.

/** Minimum pixel dimension to keep when a size is detectable from the URL. */
export const MIN_IMAGE_PX = 800;
/** Hard cap on images per product, applied after filter + main-image promotion. */
export const MAX_IMAGES_PER_PRODUCT = 8;
/** URL hint that an image is a styled/in-context shot worth showing first. */
const LIFESTYLE_RE = /lifestyle|ambiance|room/i;
// A real Aosom size marker looks like "_800x800" / "-600x600": an NxN token
// delimited by _ - or /. Bare digit runs inside the opaque hash filename are
// ignored so a coincidental match can never drop a valid image.
const DIMENSION_RE = /[_\-/](\d{2,4})[xX](\d{2,4})(?=[._\-/]|$)/g;

/**
 * Smallest explicit pixel dimension encoded in the URL, or null when none is
 * detectable (the common case for Aosom's hashed filenames).
 */
export function smallestUrlDimension(url: string): number | null {
  // Drop the /YYYY/MM/DD/ date path so it can't be misread as dimensions.
  const cleaned = url.replace(/\/\d{4}\/\d{2}\/\d{2}\//, "/");
  let min: number | null = null;
  for (const m of cleaned.matchAll(DIMENSION_RE)) {
    const lo = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
    if (min === null || lo < min) min = lo;
  }
  return min;
}

/**
 * Curate a product's image list for import:
 *  1. Drop images whose URL exposes a dimension below MIN_IMAGE_PX. Images with
 *     no detectable size are KEPT (no HEAD requests — too slow at catalog scale).
 *  2. Promote the first lifestyle/ambiance/room image to position 1; otherwise
 *     keep source order (the CSV primary image stays first).
 *  3. Cap at MAX_IMAGES_PER_PRODUCT. Promotion happens before the cap so a
 *     lifestyle shot deep in the list still survives as the main image.
 */
export function selectProductImages(images: string[]): string[] {
  const filtered = images.filter((url) => {
    const dim = smallestUrlDimension(url);
    return dim === null || dim >= MIN_IMAGE_PX;
  });

  const idx = filtered.findIndex((url) => LIFESTYLE_RE.test(url));
  const ordered =
    idx > 0
      ? [filtered[idx], ...filtered.slice(0, idx), ...filtered.slice(idx + 1)]
      : filtered;

  return ordered.slice(0, MAX_IMAGES_PER_PRODUCT);
}
