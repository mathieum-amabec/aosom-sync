/**
 * Production wiring for compare-at.ts: price history from Turso, live variants from Shopify, the one write.
 * Kept apart from the pure module so the rule stays testable without a database or a network.
 */
import { getSetting, setSetting } from "@/lib/database";
import { loadCompareAtSources } from "@/lib/price-history-db";
import { fetchShopifyVariantsPage, setVariantCompareAt } from "@/lib/shopify-client";
import type { CompareAtDeps, LiveVariant } from "@/lib/compare-at";

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
