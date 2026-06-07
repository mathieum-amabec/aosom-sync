// Feed data source: pull ACTIVE published products from Shopify (FR title + vendor +
// handle + images live there, and only Shopify knows which products are 'active').
// The pure mapper `shopifyToFeedItems` is unit-tested; `getFeedItems` does the fetch.
import { SHOPIFY } from "@/lib/config";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import { type FeedItem, mapToGoogleCategory, stripHtml, truncate } from "./feed";

export interface ShopifyFeedVariant {
  sku: string | null;
  price: string | null;
  compare_at_price?: string | null;
  inventory_quantity?: number | null;
  inventory_management?: string | null;
  title?: string | null;
}
export interface ShopifyFeedProduct {
  id: number | string;
  title: string;
  handle: string;
  vendor?: string | null;
  status: string;
  product_type?: string | null;
  body_html?: string | null;
  images?: Array<{ src: string }>;
  variants?: ShopifyFeedVariant[];
  /** English product title from the custom.title_en metafield. Only populated for the
   * EN feed; absent/empty falls back to the FR `title`. */
  titleEn?: string | null;
}

const DESCRIPTION_MAX = 5000;

/** Pure: map raw Shopify products to feed items (one per variant SKU). Active only.
 * g:id (SKU) is deduplicated across the whole feed — a duplicate g:id makes Google
 * reject/merge unpredictably, and dropship catalogs do reuse SKUs.
 *
 * When `opts.preferEnglishTitle` is set, the base title comes from `p.titleEn`
 * (custom.title_en metafield), falling back to the FR `p.title` when it's missing
 * or blank. Used by the Pinterest EN feed to reach the anglophone audience. */
export function shopifyToFeedItems(
  products: ShopifyFeedProduct[],
  opts: { preferEnglishTitle?: boolean } = {},
): FeedItem[] {
  const items: FeedItem[] = [];
  const seenIds = new Set<string>();
  let dupCount = 0;
  for (const p of products) {
    if (p.status !== "active") continue;          // published only
    if (!p.handle) continue;
    const images = (p.images ?? []).map((i) => i.src).filter(Boolean);
    if (images.length === 0) continue;            // Google/Pinterest/Meta require an image
    const link = `${STOREFRONT_BASE_URL}/products/${encodeURIComponent(p.handle)}`;
    const description = truncate(stripHtml(p.body_html ?? ""), DESCRIPTION_MAX);
    const brand = (p.vendor && p.vendor.trim()) || "Aosom";
    const cat = mapToGoogleCategory(p.product_type);
    const variants = (p.variants ?? []).filter((v) => v.sku && String(v.sku).trim() !== "");
    const multi = variants.length > 1;
    // EN feed: prefer custom.title_en; fall back to the FR title when it's absent/blank.
    const baseTitle =
      opts.preferEnglishTitle && p.titleEn && p.titleEn.trim() !== "" ? p.titleEn : p.title;

    for (const v of variants) {
      const price = parseFloat(v.price ?? "0") || 0;
      if (price <= 0) continue;
      const id = String(v.sku);
      if (seenIds.has(id)) { dupCount++; continue; } // dedup g:id across the feed
      seenIds.add(id);
      const cap = parseFloat(v.compare_at_price ?? "") || 0;
      const compareAtPrice = cap > price ? cap : null; // only a real "was" price counts
      // Dropship products are mostly untracked; treat untracked as in stock.
      const tracked = v.inventory_management != null && v.inventory_management !== "";
      const availability: FeedItem["availability"] =
        tracked && (v.inventory_quantity ?? 0) <= 0 ? "out of stock" : "in stock";
      // Differentiate variant titles when the product has real variants.
      const variantTitle = multi && v.title && v.title !== "Default Title" ? ` - ${v.title}` : "";
      items.push({
        id,
        itemGroupId: multi ? String(p.id) : null,
        title: truncate(`${baseTitle}${variantTitle}`, 150),
        description,
        link,
        imageLink: images[0],
        additionalImageLinks: images.slice(1),
        price,
        compareAtPrice,
        availability,
        condition: "new",
        brand,
        productType: p.product_type ?? "",
        googleCategoryId: cat.id,
      });
    }
  }
  if (dupCount > 0) console.warn(`[FEED] skipped ${dupCount} variants with duplicate SKUs (g:id must be unique)`);
  return items;
}

function parseNextPageInfo(link: string | null): string | null {
  if (!link) return null;
  const part = link.split(",").find((s) => s.includes('rel="next"'));
  const m = part && /<([^>]+)>/.exec(part);
  return m ? new URL(m[1]).searchParams.get("page_info") : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retry/backoff for 429 + 5xx, honoring Retry-After (Shopify is ~2 req/s). */
async function fetchWithRetry(url: string, token: string, tries = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "");
      const waitSec = !Number.isNaN(retryAfter) ? Math.min(retryAfter, 30) : Math.min(2 ** attempt, 20);
      await sleep(waitSec * 1000);
      continue;
    }
    return res;
  }
}

const MAX_PAGES = 80; // 80 * 250 = 20,000 variants — well above the catalog; guard against runaway

/** POST a GraphQL query with retry/backoff for 429 + 5xx + GraphQL THROTTLED errors. */
async function graphqlWithRetry(
  url: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  tries = 5,
): Promise<{ data?: unknown; errors?: Array<{ message: string; extensions?: { code?: string } }> }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "");
      const waitSec = !Number.isNaN(retryAfter) ? Math.min(retryAfter, 30) : Math.min(2 ** attempt, 20);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Shopify GraphQL fetch failed: ${res.status}`);
    const body = (await res.json()) as {
      data?: unknown;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
    // GraphQL throttling comes back as HTTP 200 with a THROTTLED error code.
    const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < tries) {
      await sleep(Math.min(2 ** attempt, 20) * 1000);
      continue;
    }
    return body;
  }
}

/** Fetch a map of Shopify product id → custom.title_en metafield value (non-empty only).
 * REST products.json does not return metafields, so the EN title is resolved via GraphQL. */
export async function fetchTitleEnMap(): Promise<Map<string, string>> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not configured");
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`;
  const query = `query TitleEn($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId
        metafield(namespace: "custom", key: "title_en") { value }
      }
    }
  }`;
  const map = new Map<string, string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const body = await graphqlWithRetry(url, token, query, { cursor });
    if (body.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    const conn = (body.data as {
      products?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ legacyResourceId: string; metafield: { value: string } | null }>;
      };
    })?.products;
    if (!conn) throw new Error("Shopify GraphQL returned no products connection");
    for (const node of conn.nodes) {
      const value = node.metafield?.value?.trim();
      if (value) map.set(String(node.legacyResourceId), value);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return map;
}

/** Fetch all products from Shopify (paginated) and return feed items.
 * Pass `{ english: true }` to overlay custom.title_en titles for the Pinterest EN feed. */
export async function getFeedItems(opts: { english?: boolean } = {}): Promise<FeedItem[]> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not configured");
  const base = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}`;
  const products: ShopifyFeedProduct[] = [];
  let pageInfo: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,vendor,status,product_type,body_html,images,variants" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await fetchWithRetry(`${base}/products.json?${params}`, token);
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = (await res.json()) as { products: ShopifyFeedProduct[] };
    products.push(...data.products);
    pageInfo = parseNextPageInfo(res.headers.get("Link"));
    pages++;
  } while (pageInfo && pages < MAX_PAGES);

  // Fail loud rather than silently serve (and CDN-cache for 24h) a truncated catalog.
  if (pageInfo) throw new Error(`Feed pagination exceeded ${MAX_PAGES} pages — catalog larger than expected; refusing to serve a partial feed`);

  if (opts.english) {
    const titleEnMap = await fetchTitleEnMap();
    for (const p of products) {
      const en = titleEnMap.get(String(p.id));
      if (en) p.titleEn = en;
    }
    return shopifyToFeedItems(products, { preferEnglishTitle: true });
  }

  return shopifyToFeedItems(products);
}
