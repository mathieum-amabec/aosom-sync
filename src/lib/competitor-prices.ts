/**
 * Competitor price snapshot: SKU -> current price, read from the competitor's PUBLIC Shopify catalogue
 * (`/products.json`, the same page any shopper's browser can fetch).
 *
 * Used only to cap our own price a dollar under theirs (see sell-price-rule.ts). Fail-safe by construction:
 * a truncated or failed read returns `null`, and the caller falls back to the tiered markup, so a competitor outage
 * can never move our prices on bad data.
 */

export const COMPETITOR_BASE_URL = process.env.COMPETITOR_CATALOG_URL || "https://www.ameublementarabais.ca";
/** Below this many SKUs the read is treated as truncated (their catalogue carries ~7,800). */
export const MIN_COMPETITOR_SKUS = 3000;
const PAGE_LIMIT = 250;
const MAX_PAGES = 60;
const PAGE_DELAY_MS = 400;

interface ShopifyPublicVariant {
  sku?: string | null;
  price?: string | number | null;
}
interface ShopifyPublicProduct {
  variants?: ShopifyPublicVariant[];
}

/** Fold pages of `/products.json` products into SKU -> price. SKUs are upper-cased; the first price seen wins. */
export function parseCompetitorProducts(products: ShopifyPublicProduct[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of products) {
    for (const v of p.variants ?? []) {
      const sku = String(v.sku ?? "").trim().toUpperCase();
      const price = Number(v.price);
      if (!sku || !Number.isFinite(price) || price <= 0 || out.has(sku)) continue;
      out.set(sku, price);
    }
  }
  return out;
}

export type FetchPage = (url: string) => Promise<ShopifyPublicProduct[] | null>;

async function defaultFetchPage(url: string): Promise<ShopifyPublicProduct[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; AmeubloPriceCheck)" } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const j = (await res.json()) as { products?: ShopifyPublicProduct[] };
      return Array.isArray(j.products) ? j.products : null;
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * Read the whole competitor catalogue. Returns `null` (use the tiered fallback) when any page fails mid-way or the
 * result is implausibly small; never a partial map.
 */
export async function fetchCompetitorPrices(
  opts: { baseUrl?: string; fetchPage?: FetchPage; delayMs?: number } = {},
): Promise<Map<string, number> | null> {
  const base = (opts.baseUrl ?? COMPETITOR_BASE_URL).replace(/\/$/, "");
  const fetchPage = opts.fetchPage ?? defaultFetchPage;
  const delay = opts.delayMs ?? PAGE_DELAY_MS;
  const all: ShopifyPublicProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = await fetchPage(`${base}/products.json?limit=${PAGE_LIMIT}&page=${page}`);
    if (products === null) return null; // a failed page must not yield a half catalogue
    if (products.length === 0) break;
    all.push(...products);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  const map = parseCompetitorProducts(all);
  return map.size >= MIN_COMPETITOR_SKUS ? map : null;
}
