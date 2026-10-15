/**
 * Production wiring for compare-at.ts: price history from Turso, live variants from Shopify, the one write.
 * Kept apart from the pure module so the rule stays testable without a database or a network.
 */
import { ensureSchema, getSetting, setSetting } from "@/lib/database";
import { fetchShopifyVariantsPage, setVariantCompareAt } from "@/lib/shopify-client";
import type { CompareAtDeps, LiveVariant, PriceSource, PriceStep } from "@/lib/compare-at";

const MAX_PAGES = 40;
/** Shopify Admin REST allows about 2 req/s. */
const PAGE_DELAY_MS = 550;
const WRITE_DELAY_MS = 600;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every variant of the store with its price and crossed price, page by page. */
export async function loadAllLiveVariants(): Promise<LiveVariant[]> {
  const out: LiveVariant[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchShopifyVariantsPage(cursor);
    for (const v of page.variants) {
      if (!v.sku) continue;
      out.push({ sku: v.sku, variantId: v.variantId, price: v.price, compareAtPrice: v.compareAtPrice ?? null });
    }
    cursor = page.nextPageInfo;
    if (!cursor) break;
    await sleep(PAGE_DELAY_MS);
  }
  return out;
}

/** Price steps and first-seen date for every product linked to Shopify. */
export async function loadCompareAtSources(): Promise<Map<string, PriceSource>> {
  const db = await ensureSchema();
  const prods = await db.execute(
    `SELECT sku, price, created_at FROM products WHERE price > 0 AND shopify_product_id IS NOT NULL AND shopify_product_id != ''`,
  );
  const hist = await db.execute(
    `SELECT sku, old_price, new_price, detected_at FROM price_history
     WHERE old_price IS NOT NULL AND new_price IS NOT NULL AND old_price != new_price
     ORDER BY sku, detected_at`,
  );
  const steps = new Map<string, PriceStep[]>();
  for (const h of hist.rows) {
    const sku = String(h.sku);
    const list = steps.get(sku) ?? [];
    list.push({ oldPrice: Number(h.old_price), newPrice: Number(h.new_price), at: Number(h.detected_at) });
    steps.set(sku, list);
  }
  const out = new Map<string, PriceSource>();
  for (const p of prods.rows) {
    const sku = String(p.sku);
    const created = Number(p.created_at);
    out.set(sku, { dbPrice: Number(p.price), steps: steps.get(sku) ?? [], firstSeenAt: Number.isFinite(created) && created > 0 ? created : null });
  }
  return out;
}

export function defaultCompareAtDeps(): CompareAtDeps {
  return {
    now: () => new Date(),
    getSetting,
    setSetting,
    loadLiveVariants: loadAllLiveVariants,
    loadSources: loadCompareAtSources,
    async writeCompareAt(variantId, value) {
      await setVariantCompareAt(variantId, value);
      await sleep(WRITE_DELAY_MS);
    },
  };
}
