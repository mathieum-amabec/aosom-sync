/**
 * What will sell at Costway, estimated from what sells at Aosom (Mat, 2026-10-17).
 *
 * Costway's own stock history only starts with costway_stock_history (2026-10-17), so for the first weeks the best
 * evidence is Aosom's: 30 days of stock drops per SKU (price_history, all of Aosom's channels). Both catalogues sell
 * the same kinds of furniture, so a Costway product is matched to the Aosom product type with the closest name
 * ("Furniture > Kitchen & Dining > Bar Stools" -> "… > Bar Stools") and inherits that type's sales per SKU.
 * The matched Aosom product type is also the one we give the product on Shopify, so the existing smart collections
 * (rules on product_type) pick it up by themselves.
 */
import type { Client } from "@libsql/client";

export interface AosomTypeDemand {
  /** Full Aosom product type ("Home Furnishings > Kitchen & Dining Furniture > Bar Stools"). */
  type: string;
  /** In-stock SKUs of that type. */
  skus: number;
  /** Units that left Aosom's stock over the window, all SKUs of the type. */
  units: number;
  /** units / skus: how well one product of this type sells. */
  perSku: number;
}

/** Types with fewer SKUs than this say too little to estimate from. */
const MIN_TYPE_SKUS = 3;

/** Aosom's sales per product type over `days` (drops larger than `maxStep` in one sync are glitches, not sales). */
export async function loadAosomTypeDemand(db: Client, days = 30, maxStep = 60): Promise<AosomTypeDemand[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const r = await db.execute({
    sql: `WITH d AS (
            SELECT sku, SUM(CASE WHEN old_qty > new_qty AND old_qty - new_qty <= ? THEN old_qty - new_qty ELSE 0 END) AS u
              FROM price_history WHERE change_type = 'stock_change' AND detected_at >= ? GROUP BY sku)
          SELECT p.product_type AS type, COUNT(*) AS skus, SUM(COALESCE(d.u, 0)) AS units
            FROM products p LEFT JOIN d ON d.sku = p.sku
           WHERE p.qty > 0 AND p.product_type IS NOT NULL AND p.product_type != ''
           GROUP BY p.product_type HAVING COUNT(*) >= ?`,
    args: [maxStep, since, MIN_TYPE_SKUS],
  });
  return r.rows.map((x) => {
    const skus = Number(x.skus);
    const units = Number(x.units);
    return { type: String(x.type), skus, units, perSku: skus > 0 ? Math.round((units / skus) * 10) / 10 : 0 };
  });
}

/** Words that say nothing about what the product is ("Sport Equipments" must not match "Team Sports Equipment"). */
const STOP = new Set([
  "and", "with", "for", "the", "of", "a", "set", "kids", "kid", "other", "accessories", "accessory",
  "equipment", "equipments", "supplies", "supply", "products", "product", "items",
]);

/** Same thing, different words in the two catalogues. */
const SYNONYMS: Array<[RegExp, string]> = [
  [/jewellery/g, "jewelry"],
  [/night ?stands?/g, "bedside tables"],
];

/** Lower-case word stems of a label: "Wall Mirrors & Accessories" -> {wall, mirror}. */
export function stems(label: string): Set<string> {
  const out = new Set<string>();
  let text = label.toLowerCase();
  for (const [re, to] of SYNONYMS) text = text.replace(re, to);
  for (const raw of text.split(/[^a-z]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    let w = raw;
    if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
    else if (w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
    else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

const leaf = (path: string) => path.split(">").map((s) => s.trim()).filter(Boolean).pop() ?? "";

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Below this similarity between the two leaf names, no match (better no estimate than a wrong one). 0.5 let one shared
 * word through ("Kids Bike" -> "Kids Bike Trailers", "Coolers" -> "Car Coolers").
 */
export const MIN_MATCH = 0.6;

/**
 * The Aosom product type closest to a Costway category, comparing the last level of each ("Bar Stools" vs
 * "Bar Stools"). Ties go to the type with more SKUs (a steadier estimate). Null when nothing is close enough.
 */
export function matchAosomType(costwayCategory: string, types: AosomTypeDemand[]): AosomTypeDemand | null {
  const c = stems(leaf(costwayCategory));
  if (c.size === 0) return null;
  let best: AosomTypeDemand | null = null;
  let bestScore = 0;
  for (const t of types) {
    const s = jaccard(c, stems(leaf(t.type)));
    if (s > bestScore || (s === bestScore && best !== null && t.skus > best.skus)) {
      best = t;
      bestScore = s;
    }
  }
  return bestScore >= MIN_MATCH ? best : null;
}
