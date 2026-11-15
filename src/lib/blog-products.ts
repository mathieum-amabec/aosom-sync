/**
 * Products recommended inside a blog article.
 *
 * A blog topic can name a Shopify collection (blog-topics.ts). Before generation we read a few
 * AVAILABLE, ACTIVE, Online-Store-published products from it (best-selling order), hand the model
 * their names + handles + one line of facts so it can link to them, and append a server-side
 * "Nos suggestions" / "Our picks" block so every commercial article carries product links even if
 * the model forgets. Prices are never fetched nor shown: they change daily and a stale price in a
 * blog post is a consumer-protection problem.
 *
 * Read-only on Shopify. Never throws: a failed lookup just means an article without picks.
 */
import { shopifyFetch } from "./shopify-client";
import { forbiddenBrandsIn, stripSupplierBrands } from "./catalog-guard";
import { isInternalProduct } from "./internal-product";
import type { Language } from "./blog-topics";

export interface BlogProduct {
  handle: string;
  /** Shopify (French) title. */
  titleFr: string;
  /** English title from the EN translation; absent → the product is left out of the EN article. */
  titleEn?: string;
  /** Featured image on the Shopify CDN. */
  imageUrl: string;
  imageAlt?: string;
  /** One short line of facts for the prompt (no prices). */
  factsFr: string;
  factsEn?: string;
}

/** Products shown per article. */
export const BLOG_PRODUCTS_MAX = 6;
/** Products shown in the server-side picks block (the prompt may list up to BLOG_PRODUCTS_MAX). */
export const BLOG_PICKS_MAX = 4;
/** Minimum we try to reach by topping up with non-matching products of the same collection. */
export const BLOG_PRODUCTS_MIN = 4;

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

const COLLECTION_PRODUCTS_QUERY = `query BlogCollectionProducts($handle: String!) {
  collectionByHandle(handle: $handle) {
    products(first: 50, sortKey: BEST_SELLING) {
      nodes {
        handle
        title
        status
        onlineStoreUrl
        productType
        tags
        description(truncateAt: 220)
        featuredMedia { preview { image { url altText } } }
        variants(first: 20) { nodes { availableForSale } }
        translations(locale: "en") { key value }
      }
    }
  }
}`;

interface GqlProduct {
  handle?: string;
  title?: string;
  status?: string;
  onlineStoreUrl?: string | null;
  productType?: string | null;
  tags?: string[];
  description?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string; altText?: string | null } | null } | null } | null;
  variants?: { nodes?: Array<{ availableForSale?: boolean }> };
  translations?: Array<{ key?: string; value?: string | null }>;
}

const plain = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** A product title is unsafe in a blog when it names a supplier or carries a price / percentage. */
export function isBlogSafeText(s: string): boolean {
  return forbiddenBrandsIn(s).length === 0 && !/\$|%|\bCAD\b/i.test(s);
}

/**
 * One line of facts from a description: first sentence, supplier names stripped, any money amount
 * or percentage removed, capped at 140 chars.
 */
export function factsLine(description: string | null | undefined, productType?: string | null): string {
  const text = stripSupplierBrands(plain(description ?? ""));
  const first = (text.match(/^[^.!?]{10,}[.!?]/)?.[0] ?? text).trim();
  const cleaned = first
    .replace(/(?:CA)?\$\s?\d[\d\s.,]*|\d[\d\s.,]*\s?(?:\$|CAD\b|dollars?\b)/gi, "")
    .replace(/\d+(?:[.,]\d+)?\s?%/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const out = cleaned.length > 140 ? `${cleaned.slice(0, 139).replace(/\s+\S*$/, "")}…` : cleaned;
  return out || (productType ?? "").trim();
}

/** Map one GraphQL node to a BlogProduct, or null when it must not be recommended. */
export function toBlogProduct(n: GqlProduct): BlogProduct | null {
  const handle = n.handle ?? "";
  const title = (n.title ?? "").trim();
  const imageUrl = n.featuredMedia?.preview?.image?.url ?? "";
  if (!HANDLE_RE.test(handle) || !title || !/^https:\/\//.test(imageUrl)) return null;
  if (n.status !== "ACTIVE" || !n.onlineStoreUrl) return null; // drafts / archived / unpublished
  if (!(n.variants?.nodes ?? []).some((v) => v.availableForSale)) return null; // nothing to sell
  if (isInternalProduct({ product_type: n.productType, tags: n.tags })) return null; // warranty product
  if (!isBlogSafeText(title)) return null;

  const tr = (key: string) => (n.translations ?? []).find((t) => t.key === key)?.value?.trim() || undefined;
  const titleEn = tr("title");
  const enDescription = tr("body_html");
  return {
    handle,
    titleFr: title,
    ...(titleEn && isBlogSafeText(titleEn) ? { titleEn } : {}),
    imageUrl,
    ...(n.featuredMedia?.preview?.image?.altText ? { imageAlt: n.featuredMedia.preview.image.altText } : {}),
    factsFr: factsLine(n.description, n.productType),
    ...(enDescription ? { factsEn: factsLine(enDescription, n.productType) } : {}),
  };
}

/**
 * Choose up to `max` products: those whose FR title matches `titlePattern` first (best-selling
 * order kept), topped up with the others only while fewer than `min` match.
 */
export function chooseProducts(products: BlogProduct[], titlePattern?: string, max = BLOG_PRODUCTS_MAX, min = BLOG_PRODUCTS_MIN): BlogProduct[] {
  let re: RegExp | null = null;
  if (titlePattern) {
    try {
      re = new RegExp(titlePattern, "i");
    } catch {
      re = null;
    }
  }
  // Colour variants are often separate products with the SAME title: keep the first (best seller)
  // so the picks never show the same name twice.
  const seen = new Set<string>();
  const unique = products.filter((p) => {
    const key = p.titleFr.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const matching = re ? unique.filter((p) => re!.test(p.titleFr)) : unique;
  const picked = matching.slice(0, max);
  if (picked.length < min) {
    for (const p of unique) {
      if (picked.length >= min) break;
      if (!picked.includes(p)) picked.push(p);
    }
  }
  return picked;
}

export type ShopifyFetchLike = (endpoint: string, init?: RequestInit) => Promise<Response>;

/**
 * Read the products to recommend for a collection. Never throws — returns [] on any failure
 * (unknown handle, Shopify error, timeout) so the article is still generated, just without picks.
 */
export async function fetchCollectionProducts(
  collection: string,
  opts: { titlePattern?: string; max?: number } = {},
  doFetch: ShopifyFetchLike = shopifyFetch,
): Promise<BlogProduct[]> {
  if (!HANDLE_RE.test(collection)) return [];
  try {
    const res = await doFetch("/graphql.json", {
      method: "POST",
      body: JSON.stringify({ query: COLLECTION_PRODUCTS_QUERY, variables: { handle: collection } }),
    });
    if (!res.ok) {
      console.error(`[blog-products] ${collection}: Shopify ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { data?: { collectionByHandle?: { products?: { nodes?: GqlProduct[] } } | null }; errors?: unknown };
    if (json.errors) console.error(`[blog-products] ${collection}: GraphQL errors`, JSON.stringify(json.errors).slice(0, 300));
    const nodes = json.data?.collectionByHandle?.products?.nodes ?? [];
    const products = nodes.map(toBlogProduct).filter((p): p is BlogProduct => p !== null);
    return chooseProducts(products, opts.titlePattern, opts.max ?? BLOG_PRODUCTS_MAX);
  } catch (err) {
    console.error(`[blog-products] ${collection}: lookup failed`, err);
    return [];
  }
}

/** Products usable in an article of `lang` (EN needs an English title). */
export function productsForLang(products: readonly BlogProduct[], lang: Language): BlogProduct[] {
  return lang === "fr" ? [...products] : products.filter((p) => !!p.titleEn);
}

const GRID_STYLE = "list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px";
const IMG_STYLE = "width:100%;height:auto";

const nameOf = (p: BlogProduct, lang: Language) => (lang === "fr" ? p.titleFr : p.titleEn ?? p.titleFr);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Prompt section listing the products the model may recommend. Names, relative URLs and one line
 * of facts only — never prices.
 */
export function buildProductPromptContext(
  products: readonly BlogProduct[],
  lang: Language,
  collection?: string,
  relatedCollections: readonly string[] = [],
): string {
  const list = productsForLang(products, lang);
  if (list.length === 0) return "";
  const lines = list.map((p) => {
    const facts = lang === "fr" ? p.factsFr : p.factsEn ?? "";
    return `- ${nameOf(p, lang)} — /products/${p.handle}${facts ? ` — ${facts}` : ""}`;
  });
  const colls = [collection, ...relatedCollections].filter((c): c is string => !!c && HANDLE_RE.test(c));
  return [
    "Products from our store that fit this topic (real and currently available). Recommend 2 to 4 of them naturally where they genuinely help the reader, each as an HTML link to its relative URL exactly as given below. Never invent other products, never link to a product that is not listed, never state or guess a price, a discount or a promotion, and do not add specifications beyond the facts given:",
    ...lines,
    ...(colls.length
      ? [`Collection page(s) you may link to once each (relative URLs): ${colls.map((c) => `/collections/${c}`).join(", ")}.`]
      : []),
  ].join("\n");
}

/**
 * Server-side "Nos suggestions" / "Our picks" block appended to the article: real product image
 * (Shopify CDN), name and relative link. Supplier-named products are dropped (and names re-stripped
 * as a second line of defence); no price is ever rendered. Returns "" when nothing is usable.
 */
export function buildProductPicksHtml(products: readonly BlogProduct[], lang: Language, collection?: string): string {
  const list = productsForLang(products, lang)
    .filter((p) => HANDLE_RE.test(p.handle) && /^https:\/\//.test(p.imageUrl) && isBlogSafeText(nameOf(p, lang)))
    .slice(0, BLOG_PICKS_MAX);
  if (list.length === 0) return "";
  const heading = lang === "fr" ? "Nos suggestions" : "Our picks";
  const seeAll = lang === "fr" ? "Voir toute la collection" : "See the whole collection";
  const items = list.map((p) => {
    const name = esc(stripSupplierBrands(nameOf(p, lang)));
    const href = `/products/${p.handle}`;
    return `<li><a href="${href}"><img src="${esc(p.imageUrl)}" alt="${name}" loading="lazy" style="${IMG_STYLE}" /></a><br /><a href="${href}">${name}</a></li>`;
  });
  // Inline styles on purpose: the block must render as a grid without touching the live theme.
  return [
    `<h2>${heading}</h2>`,
    `<ul class="blog-product-picks" style="${GRID_STYLE}">${items.join("")}</ul>`,
    collection && HANDLE_RE.test(collection) ? `<p><a href="/collections/${collection}">${seeAll}</a></p>` : "",
  ].join("");
}

/**
 * Unwrap links the model made to /products/<handle> pages it was NOT given (an invented or stale
 * product): the anchor text stays, the link goes. With no known handles every product link is unwrapped.
 */
export function unwrapUnknownProductLinks(html: string, knownHandles: ReadonlySet<string>): string {
  return html.replace(
    /<a\s[^>]*href=["'](?:https?:\/\/[^"'/]+)?\/(?:[a-z]{2}\/)?products\/([^"'?#/]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    (whole, handle: string, text: string) => (knownHandles.has(handle.toLowerCase()) ? whole : text),
  );
}

/**
 * Same for /collections/<handle> (optionally /xx/collections/…): only the topic's collection and
 * its related collections may be linked — anything else the model wrote may not exist (404).
 */
export function unwrapUnknownCollectionLinks(html: string, allowedCollections: ReadonlySet<string>): string {
  return html.replace(
    /<a\s[^>]*href=["'](?:https?:\/\/[^"'/]+)?\/(?:[a-z]{2}\/)?collections\/([^"'?#/]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    (whole, handle: string, text: string) => (allowedCollections.has(handle.toLowerCase()) ? whole : text),
  );
}
