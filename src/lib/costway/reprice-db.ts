/**
 * Production wiring for reprice.ts: Costway rows and our price history from Turso, live variants from Shopify.
 */
import { ensureSchema, getSetting, setSetting } from "@/lib/database";
import { setVariantCompareAt, shopifyFetch, updateShopifyVariantPrice } from "@/lib/shopify-client";
import type { LiveVariant } from "@/lib/compare-at";
import { costwaySources, type CostwayRepriceDeps, type CostwayRow } from "./reprice";

/** Shopify Admin REST allows about 2 req/s. */
const DELAY_MS = 550;
/** products.json accepts up to 250 ids per call. */
const IDS_PER_CALL = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadRows(): Promise<CostwayRow[]> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT sku, internal_sku, shopify_product_id, price, price_drop, promo_tag FROM costway_products
      WHERE shopify_product_id IS NOT NULL AND shopify_product_id != '' AND internal_sku IS NOT NULL AND removed_at IS NULL`,
  );
  return res.rows.map((r) => ({
    sku: String(r.sku),
    internalSku: String(r.internal_sku),
    shopifyProductId: String(r.shopify_product_id),
    price: Number(r.price),
    priceDrop: r.price_drop == null ? null : Number(r.price_drop),
    promoTag: String(r.promo_tag ?? ""),
  }));
}

async function loadLive(productIds: string[]): Promise<LiveVariant[]> {
  const out: LiveVariant[] = [];
  for (let i = 0; i < productIds.length; i += IDS_PER_CALL) {
    const ids = productIds.slice(i, i + IDS_PER_CALL).join(",");
    const res = await shopifyFetch(`/products.json?ids=${ids}&limit=250&fields=id,variants`);
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = (await res.json()) as { products: Array<{ variants: Array<{ id: number; sku: string | null; price: string; compare_at_price: string | null }> }> };
    for (const p of data.products) {
      for (const v of p.variants) {
        if (!v.sku) continue;
        const ca = v.compare_at_price == null ? NaN : Number(v.compare_at_price);
        out.push({ sku: v.sku, variantId: String(v.id), price: Number(v.price), compareAtPrice: Number.isFinite(ca) && ca > 0 ? ca : null });
      }
    }
    await sleep(DELAY_MS);
  }
  return out;
}

export function defaultCostwayRepriceDeps(): CostwayRepriceDeps {
  return {
    now: () => new Date(),
    getSetting,
    setSetting,
    loadRows,
    loadLive,
    async writePrice(variantId, price) {
      // No oldPrice: the crossed price is the compare-at step's job (it also sees a slide in small steps).
      await updateShopifyVariantPrice(variantId, price);
      await sleep(DELAY_MS);
    },
    async recordChange(c, atS) {
      const db = await ensureSchema();
      await db.batch(
        [
          { sql: `UPDATE costway_products SET sell_price = ? WHERE sku = ?`, args: [c.to, c.sku] },
          {
            sql: `INSERT INTO sell_price_history (sku, old_price, new_price, aosom_price, reason, detected_at) VALUES (?, ?, ?, ?, 'costway', ?)`,
            args: [c.internalSku, c.from, c.to, c.costwayPrice, atS],
          },
        ],
        "write",
      );
    },
    async loadSources(rows, live) {
      const db = await ensureSchema();
      const imported = await db.execute(
        `SELECT internal_sku, COALESCE(imported_at, first_seen_at) AS imported_at FROM costway_products WHERE internal_sku IS NOT NULL AND shopify_product_id IS NOT NULL AND shopify_product_id != ''`,
      );
      const firstSeen = new Map(imported.rows.map((r) => [String(r.internal_sku), r.imported_at == null ? null : Number(r.imported_at)]));
      const hist = await db.execute(
        `SELECT sku, old_price, new_price, detected_at FROM sell_price_history WHERE reason = 'costway' ORDER BY sku, detected_at`,
      );
      return costwaySources(
        rows.map((r) => ({ internalSku: r.internalSku, firstSeenAt: firstSeen.get(r.internalSku) ?? null })),
        live,
        hist.rows.map((h) => ({ sku: String(h.sku), oldPrice: h.old_price == null ? null : Number(h.old_price), newPrice: Number(h.new_price), at: Number(h.detected_at) })),
      );
    },
    async writeCompareAt(variantId, value) {
      await setVariantCompareAt(variantId, value);
      await sleep(DELAY_MS);
    },
  };
}
