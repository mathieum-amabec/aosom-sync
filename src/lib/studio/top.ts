/**
 * Studio top list — Aosom best sellers, one row per Shopify PRODUCT (colour variants summed).
 *
 * Signal = units that left Aosom's stock over the window (price_history stock_change rows
 * where qty went down), the same velocity every other selector uses. It measures what sells
 * at Aosom across all its resellers, NOT our own Shopify sales (read_orders isn't granted).
 */
import { ensureSchema } from "@/lib/database";
import { fetchProductSummaries } from "./shopify";
import { skusWithBeforeAfter } from "./db";

export interface StudioTopProduct {
  rank: number;
  shopifyProductId: string;
  sku: string;
  skus: string[];
  title: string;
  productType: string;
  price: number;
  stock: number;
  velocity: number;
  thumbnail: string | null;
  imageCount: number;
  status: string;
  hasBeforeAfter: boolean;
}

export async function getStudioTop(opts: { limit?: number; windowDays?: number } = {}): Promise<StudioTopProduct[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const windowDays = opts.windowDays ?? 14;
  const db = await ensureSchema();
  const res = await db.execute({
    sql: `
      SELECT p.shopify_product_id AS pid,
             GROUP_CONCAT(DISTINCT p.sku) AS skus,
             MIN(p.product_type) AS product_type,
             MIN(p.price) AS price,
             SUM(v.moved) AS velocity
        FROM (SELECT sku, SUM(old_qty - new_qty) AS moved
                FROM price_history
               WHERE change_type = 'stock_change'
                 AND detected_at > cast(strftime('%s','now', ?) as integer)
                 AND old_qty > new_qty
               GROUP BY sku) v
        JOIN products p ON p.sku = v.sku
       WHERE p.shopify_product_id IS NOT NULL AND p.shopify_product_id != ''
       GROUP BY p.shopify_product_id
       ORDER BY velocity DESC
       LIMIT ?`,
    args: [`-${windowDays} days`, limit],
  });
  const rows = res.rows.map((r) => ({
    pid: String(r.pid),
    skus: String(r.skus ?? "").split(",").filter(Boolean),
    productType: String(r.product_type ?? ""),
    price: Number(r.price ?? 0),
    velocity: Number(r.velocity ?? 0),
  }));
  if (!rows.length) return [];

  // Current stock per product (all its variants).
  const allSkus = rows.flatMap((r) => r.skus);
  const ph = allSkus.map(() => "?").join(",");
  const stockRes = await db.execute({ sql: `SELECT sku, qty FROM products WHERE sku IN (${ph})`, args: allSkus });
  const qtyBySku = new Map(stockRes.rows.map((r) => [String(r.sku), Number(r.qty ?? 0)]));

  const [summaries, done] = await Promise.all([fetchProductSummaries(rows.map((r) => r.pid)), skusWithBeforeAfter(allSkus)]);

  return rows.map((r, i) => {
    const s = summaries.get(r.pid.replace("gid://shopify/Product/", ""));
    return {
      rank: i + 1,
      shopifyProductId: r.pid.replace("gid://shopify/Product/", ""),
      sku: r.skus[0] ?? "",
      skus: r.skus,
      title: s?.title ?? r.skus[0] ?? r.pid,
      productType: r.productType,
      price: r.price,
      stock: r.skus.reduce((n, sku) => n + (qtyBySku.get(sku) ?? 0), 0),
      velocity: r.velocity,
      thumbnail: s?.thumbnail ?? null,
      imageCount: s?.imageCount ?? 0,
      status: s?.status ?? "UNKNOWN",
      hasBeforeAfter: r.skus.some((sku) => done.has(sku)),
    };
  });
}
