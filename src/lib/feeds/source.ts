// Feed data source: pull ACTIVE published products from Shopify (FR title + vendor +
// handle + images live there, and only Shopify knows which products are 'active').
// The pure mapper `shopifyToFeedItems` is unit-tested; `getFeedItems` does the fetch.
import { SHOPIFY } from "@/lib/config";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import { type FeedItem, mapToGoogleCategory, stripHtml, truncate } from "./feed";
import { parseSku } from "../variant-merger";

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
  /** Shopify Online Store publish timestamp (ISO) — null when the product is active but
   * NOT published to the storefront. Such a product's /products/{handle} page 404s, so it
   * must be excluded from the feed (Google Merchant: "Product page unavailable"). */
  published_at?: string | null;
  images?: Array<{ src: string }>;
  variants?: ShopifyFeedVariant[];
  /** English product title from the custom.title_en metafield. Only populated for the
   * EN feed; absent/empty falls back to the FR `title`. */
  titleEn?: string | null;
}

const DESCRIPTION_MAX = 5000;

// Hide the dropship supplier ("Aosom") from public feeds — "Ameublo Direct" is the
// storefront brand customers should see. Drives the brand fallback and scrubs the supplier
// name out of titles/descriptions so the feeds carry zero supplier references.
// NOTE: a product's URL handle can still embed "aosom" (e.g. /products/...-aosom-...);
// those are live Shopify handles and must be changed Shopify-side (+ redirects) — they
// cannot be rewritten in the feed without producing 404 links.
const HOUSE_BRAND = "Ameublo Direct";
const SUPPLIER_WORD = /\baosom\b/i; // single match (no /g — safe with .test())
const SUPPLIER_GLOBAL = /\baosom\b/gi; // replace-all

/** Replace any "Aosom" occurrence with the house brand and tidy whitespace. */
export function scrubSupplier(s: string): string {
  return s.replace(SUPPLIER_GLOBAL, HOUSE_BRAND).replace(/\s{2,}/g, " ").trim();
}

// Aosom variant "size" options carry English/imperial measurements that leak into the FR
// title as a trailing `… - Couleur / <dims>` suffix, e.g. `42.1" x 24.6" x 17.3"`,
// `15.7" W x 11.8" D x 19.3" H` (spaces optional before the L/W/D/H letter), an adjustable
// range `43.75"-46.75" H`, or a width-only `47"`. For the Quebec FR / metric market those
// suffixes are noise, so we drop the trailing block.
//
// Matched conservatively so a real product name is never eaten. Only the TRAILING run is
// removed, in one of two shapes:
//   ALT1 — a `/`-delimited run: " / " (the variant-option delimiter) followed by any inch
//          run. The leading-space requirement keeps fractions like `1/2"` from matching.
//   ALT2 — no slash, but unambiguous: two+ axes joined by `x`, OR a single axis that bears a
//          dimension letter (L/W/D/H). A lone bare `50"` in a real name has neither → kept.
// Each axis allows an adjustable `N"-M"` range and an optional trailing dimension letter.
const AXIS = `\\d+(?:\\.\\d+)?\\s*"\\s*(?:[-\\u2013]\\s*\\d+(?:\\.\\d+)?\\s*"\\s*)?[LWDH]?`;
const AXES = `${AXIS}(?:\\s*[x\\u00d7]\\s*${AXIS})*`; // one or more axes joined by x
const AXES_MULTI = `${AXIS}(?:\\s*[x\\u00d7]\\s*${AXIS})+`; // two or more axes
const AXIS_LETTERED = `\\d+(?:\\.\\d+)?\\s*"\\s*(?:[-\\u2013]\\s*\\d+(?:\\.\\d+)?\\s*"\\s*)?[LWDH]`;
const IMPERIAL_DIM_SUFFIX = new RegExp(
  `(?:\\s+/\\s*${AXES}|\\s*[,\\u2013\\u2014-]?\\s*(?:${AXES_MULTI}|${AXIS_LETTERED}))\\s*$`,
  "i",
);

/** Strip a trailing imperial dimension suffix from a feed title (see IMPERIAL_DIM_SUFFIX).
 * Returns the title unchanged when no such suffix is present; otherwise removes it and
 * tidies any leftover trailing separator/comma/whitespace. */
export function stripImperialDimensions(title: string): string {
  const src = String(title ?? "");
  const cleaned = src.replace(IMPERIAL_DIM_SUFFIX, "");
  if (cleaned === src) return src;
  return cleaned.replace(/[\s,/–—-]+$/u, "").trim();
}

/** Brand to show: keep a real product vendor (Outsunny, …); replace empty or the
 * supplier name ("Aosom") with the house brand. */
function resolveBrand(vendor: string | null | undefined): string {
  const v = (vendor ?? "").trim();
  return !v || SUPPLIER_WORD.test(v) ? HOUSE_BRAND : v;
}

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
  let unpublishedCount = 0;
  for (const p of products) {
    if (p.status !== "active") continue;          // active status
    // Must be published to the Online Store *now* — an active product is only live on the
    // storefront when published_at is set AND not in the future. null = never published;
    // a future timestamp = a scheduled publish that isn't live yet. Either way
    // /products/{handle} 404s and Google Merchant flags "Product page unavailable", so
    // exclude it rather than ship a dead link.
    if (!p.published_at || new Date(p.published_at).getTime() > Date.now()) { unpublishedCount++; continue; }
    if (!p.handle) continue;
    const images = (p.images ?? []).map((i) => i.src).filter(Boolean);
    if (images.length === 0) continue;            // Google/Pinterest/Meta require an image
    const link = `${STOREFRONT_BASE_URL}/products/${encodeURIComponent(p.handle)}`;
    const description = truncate(scrubSupplier(stripHtml(p.body_html ?? "")), DESCRIPTION_MAX);
    const brand = resolveBrand(p.vendor);
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
        title: truncate(stripImperialDimensions(scrubSupplier(`${baseTitle}${variantTitle}`)), 150),
        description,
        link,
        imageLink: images[0],
        additionalImageLinks: images.slice(1),
        price,
        compareAtPrice,
        availability,
        condition: "new",
        brand,
        // FR colour from the SKU suffix (COLOR_MAP), e.g. ...GY → "Gris". null when the
        // SKU has no recognised colour suffix. Drives <g:color> on the Google feed.
        color: parseSku(id).color,
        productType: p.product_type ?? "",
        googleCategoryId: cat.id,
      });
    }
  }
  if (unpublishedCount > 0) console.warn(`[FEED] excluded ${unpublishedCount} active products not published to the Online Store (storefront would 404)`);
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
    // Cache the (paginated) Shopify product data in Next's Data Cache, tagged 'feeds'.
    // revalidate=86400 keeps a 24h baseline; POST /api/revalidate calls
    // revalidateTag('feeds') to refresh on demand (e.g. right after a catalog sync).
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token },
      next: { revalidate: 86400, tags: ["feeds"] },
    });
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
 * REST products.json does not return metafields, so the EN title is resolved via GraphQL.
 * Note: this is a POST, which Next does not Data-Cache — so EN titles are always fetched
 * fresh and are NOT covered by the 'feeds' tag / POST /api/revalidate. Only the EN feed
 * (pinterest-en) pays this per regeneration. */
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
    const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,vendor,status,product_type,body_html,images,variants,published_at" });
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
