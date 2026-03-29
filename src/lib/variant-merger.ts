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
