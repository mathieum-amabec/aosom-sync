/**
 * Draft → 301 redirect.
 *
 * WHY: a Shopify product page answers 404 as soon as the product is DRAFT. Our crons draft
 * products all the time (sold out → `auto-drafted`, gone from the feed, stale-catalog,
 * out of season), but the URL keeps its Google ranking, its ChatGPT citations, its Meta/
 * Pinterest links and its internal links. Audit 2026-11-24: 70 drafted products were still
 * landing 877 Canadian sessions / 30 days on a 404.
 *
 * WHAT: when a product goes DRAFT we create a URL redirect `/products/<handle>` → the most
 * specific collection it belongs to (smallest non-promo collection with ≥ MIN_ACTIVE active
 * products), falling back to a storefront search for its title.
 *
 * SAFE WHEN THE PRODUCT COMES BACK: Shopify only applies a URL redirect when the path 404s.
 * Verified live 2026-11-24 — an ACTIVE product with a redirect on its path still renders 200.
 * So no cleanup is needed on reactivation; the redirect simply sleeps until the next draft.
 *
 * NEVER OVERRIDES: if a redirect already exists for the path (operator's, or Shopify's own
 * handle-change redirect), it is left untouched.
 *
 * Two entry points:
 *  - `redirectOnDraft()` — called by `updateShopifyProduct` right after a successful
 *    status→draft PUT (the moment the sync/crons draft a product). Never throws; bounded by
 *    INLINE_BUDGET per rolling window so a mass-draft run can't stall the sync.
 *  - `runDraftRedirectReconcile()` — cron safety net (drafts made in the Admin, via GraphQL,
 *    inline budget overflow, transient failures). Dry-run unless `{ apply: true }`.
 */
import { shopifyFetch } from "./shopify-client";
import { isInternalProduct } from "./internal-product";

/** Storefront origin used to confirm the chosen target renders (200) before we commit to it. */
export const STORE_ORIGIN = "https://ameublodirect.ca";
/** A target collection must show at least this many ACTIVE products. */
export const MIN_ACTIVE = 4;
/** Collections never used as a target: promos, catch-alls, seasonal/BF rails, internal ones. */
export const EXCLUDED_COLLECTION =
  /rabais|nouveaux-arrivages|black-friday|liquidation|vendredi|^meubles-et-decorations$|^meubles-deco$|^all$|frontpage|promo|aubaine|cadeau|meilleur|best|vedette|tendance|^noel$|exclusiv|^tous|deuxieme|2e-article|moins-de|sous-|soldes|suivi-source|coups-de-coeur|^collection-|printemps|-lifestyle$/;
/** Tags that mean "this draft was never live / is not a customer product" → no redirect. */
export const SKIP_TAGS = ["needs-review"];
/** Max collections examined per product (active-count query each). */
const MAX_CANDIDATES = 4;
/** Spacing between Shopify calls (≤ 2 req/s, same as the other crons). */
export const RATE_LIMIT_MS = 500;
/** Inline (in-request) redirect creations allowed per rolling window — overflow → reconcile cron. */
export const INLINE_BUDGET = 25;
const INLINE_WINDOW_MS = 10 * 60_000;
/** Default creates per reconcile run (first runs drain the historical backlog). */
export const RECONCILE_CAP = 150;

let rateLimitMs = RATE_LIMIT_MS;
/** Test hook: shorten the spacing between Shopify calls. */
export function _setRateLimitMs(ms: number): void {
  rateLimitMs = ms;
}
const sleep = () => (rateLimitMs > 0 ? new Promise((r) => setTimeout(r, rateLimitMs)) : Promise.resolve());

export interface CandidateCollection {
  handle: string;
  /** products in the collection, all statuses (Admin productsCount). */
  productsCount: number;
}

/**
 * Pure: order the product's collections from most to least specific, dropping promo/catch-all
 * ones and the tiny ones. Smallest first = most specific (e.g. salon-canapes-3-places before
 * meubles-salon).
 */
export function rankCandidateCollections(collections: CandidateCollection[]): CandidateCollection[] {
  return collections
    .filter((c) => !EXCLUDED_COLLECTION.test(c.handle) && c.productsCount >= MIN_ACTIVE)
    .sort((a, b) => a.productsCount - b.productsCount || a.handle.localeCompare(b.handle));
}

/** Pure: storefront search fallback built from the product title (first meaningful words). */
export function searchFallback(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4);
  return words.length ? `/search?q=${encodeURIComponent(words.join(" "))}` : "/collections/all";
}

/** Pure: should this product get a redirect at all? */
export function shouldRedirect(p: { status: string; productType?: string | null; tags: string[] }): boolean {
  if (p.status.toLowerCase() !== "draft") return false;
  if (isInternalProduct({ product_type: p.productType ?? "", tags: p.tags })) return false;
  const lower = p.tags.map((t) => t.trim().toLowerCase());
  return !SKIP_TAGS.some((t) => lower.includes(t));
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

interface ProductForRedirect {
  handle: string;
  title: string;
  status: string;
  productType: string | null;
  tags: string[];
  collections: CandidateCollection[];
}

async function loadProduct(shopifyId: string): Promise<ProductForRedirect | null> {
  const gid = shopifyId.startsWith("gid://") ? shopifyId : `gid://shopify/Product/${shopifyId}`;
  const d = await gql<{
    product: null | {
      handle: string; title: string; status: string; productType: string | null; tags: string[];
      collections: { nodes: { handle: string; productsCount: { count: number } }[] };
    };
  }>(
    `query($id:ID!){product(id:$id){handle title status productType tags collections(first:30){nodes{handle productsCount{count}}}}}`,
    { id: gid },
  );
  const p = d.product;
  if (!p) return null;
  return {
    handle: p.handle, title: p.title, status: p.status, productType: p.productType, tags: p.tags,
    collections: p.collections.nodes.map((c) => ({ handle: c.handle, productsCount: c.productsCount.count })),
  };
}

/** Count ACTIVE products among the first 50 of a collection (drafts/out-of-season don't count). */
async function activeCount(handle: string): Promise<number> {
  const d = await gql<{ collectionByHandle: null | { products: { nodes: { status: string }[] } } }>(
    `query($h:String!){collectionByHandle(handle:$h){products(first:50){nodes{status}}}}`,
    { h: handle },
  );
  return (d.collectionByHandle?.products.nodes ?? []).filter((n) => n.status === "ACTIVE").length;
}

/**
 * Does the target render on the storefront? 200 = yes. 301/302/404 = no (unpublished collection,
 * or itself redirected → Shopify rejects "redirect to another redirect"). Anything else (429,
 * network) = unknown → treated as OK, the Admin evidence (active products) already passed.
 */
async function storefrontOk(path: string): Promise<boolean> {
  try {
    const r = await fetch(STORE_ORIGIN + path, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; aosom-sync redirect check)", accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 200) return true;
    if (r.status === 404 || (r.status >= 300 && r.status < 400)) return false;
    return true;
  } catch {
    return true;
  }
}

async function existingRedirectTarget(path: string): Promise<string | null> {
  const res = await shopifyFetch(`/redirects.json?path=${encodeURIComponent(path)}&fields=id,path,target`);
  if (!res.ok) throw new Error(`Shopify redirects lookup ${res.status}`);
  const j = (await res.json()) as { redirects?: { path: string; target: string }[] };
  const hit = (j.redirects ?? []).find((r) => r.path === path);
  return hit ? hit.target : null;
}

async function createRedirect(path: string, target: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await shopifyFetch(`/redirects.json`, {
    method: "POST",
    body: JSON.stringify({ redirect: { path, target } }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
}

export type DraftRedirectOutcome =
  | { status: "created"; path: string; target: string }
  | { status: "planned"; path: string; target: string }
  | { status: "exists"; path: string; target: string }
  | { status: "skipped"; reason: string; path?: string }
  | { status: "failed"; path?: string; error: string };

/**
 * Create the redirect for one product if it is a customer-facing DRAFT without one.
 * `apply: false` plans only (picks the target, writes nothing).
 */
export async function ensureDraftRedirect(
  shopifyId: string,
  opts: { apply?: boolean; product?: ProductForRedirect } = {},
): Promise<DraftRedirectOutcome> {
  const apply = opts.apply !== false;
  const p = opts.product ?? (await loadProduct(shopifyId));
  if (!p) return { status: "skipped", reason: "product not found" };
  if (!shouldRedirect(p)) return { status: "skipped", reason: `not eligible (${p.status})` };

  const path = `/products/${p.handle}`;
  const already = await existingRedirectTarget(path);
  if (already) return { status: "exists", path, target: already };

  const tried: string[] = [];
  for (const c of rankCandidateCollections(p.collections).slice(0, MAX_CANDIDATES)) {
    await sleep();
    if ((await activeCount(c.handle)) < MIN_ACTIVE) { tried.push(`${c.handle}:few-active`); continue; }
    const target = `/collections/${c.handle}`;
    if (!(await storefrontOk(target))) { tried.push(`${c.handle}:not-200`); continue; }
    if (!apply) return { status: "planned", path, target };
    await sleep();
    const r = await createRedirect(path, target);
    if (r.ok) return { status: "created", path, target };
    tried.push(`${c.handle}:${r.error}`);
  }

  const fallback = searchFallback(p.title);
  if (!apply) return { status: "planned", path, target: fallback };
  await sleep();
  const r = await createRedirect(path, fallback);
  if (r.ok) return { status: "created", path, target: fallback };
  return { status: "failed", path, error: `${r.error} | tried ${tried.join(", ")}` };
}

const inlineStamps: number[] = [];

/**
 * Hook for `updateShopifyProduct` after a successful status→draft PUT. NEVER throws (a redirect
 * problem must not fail a stock/sync write). Bounded by INLINE_BUDGET per rolling window; the
 * overflow is picked up by the reconcile cron. Disabled with DRAFT_REDIRECT_INLINE=0.
 */
export async function redirectOnDraft(shopifyId: string): Promise<DraftRedirectOutcome | null> {
  if (process.env.DRAFT_REDIRECT_INLINE === "0") return null;
  const now = Date.now();
  while (inlineStamps.length && now - inlineStamps[0] > INLINE_WINDOW_MS) inlineStamps.shift();
  if (inlineStamps.length >= INLINE_BUDGET) return { status: "skipped", reason: "inline budget — reconcile cron will handle it" };
  inlineStamps.push(now);
  try {
    const out = await ensureDraftRedirect(shopifyId, { apply: true });
    if (out.status === "created") console.log(`[draft-redirect] ${out.path} → ${out.target}`);
    if (out.status === "failed") console.warn(`[draft-redirect] failed ${out.path}: ${out.error}`);
    return out;
  } catch (err) {
    console.warn(`[draft-redirect] error for ${shopifyId}:`, err instanceof Error ? err.message : err);
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test hook: reset the inline budget window. */
export function _resetInlineBudget(): void {
  inlineStamps.length = 0;
}

async function listRedirectedProductPaths(): Promise<Set<string>> {
  const paths = new Set<string>();
  let next: string | null = `/redirects.json?limit=250&fields=path`;
  while (next) {
    const res: Response = await shopifyFetch(next);
    if (!res.ok) throw new Error(`Shopify redirects list ${res.status}`);
    const j = (await res.json()) as { redirects?: { path: string }[] };
    for (const r of j.redirects ?? []) if (r.path.startsWith("/products/")) paths.add(r.path);
    const link = res.headers.get("link") ?? "";
    const m = link.match(/<[^>]*\/redirects\.json\?([^>]*page_info=[^>]*)>;\s*rel="next"/);
    next = m ? `/redirects.json?${m[1]}` : null;
    if (next) await sleep();
  }
  return paths;
}

export interface DraftRedirectReconcileResult {
  dryRun: boolean;
  drafts: number;
  eligible: number;
  alreadyRedirected: number;
  missing: number;
  created: number;
  planned: number;
  failed: number;
  deferred: number;
  samples: DraftRedirectOutcome[];
}

/**
 * Safety net: every customer-facing DRAFT product without a redirect gets one. Dry-run unless
 * `apply`. Caps creations per run (`cap`) and reports the rest as `deferred`.
 */
export async function runDraftRedirectReconcile(
  opts: { apply?: boolean; cap?: number } = {},
): Promise<DraftRedirectReconcileResult> {
  const apply = opts.apply === true;
  const cap = opts.cap ?? RECONCILE_CAP;
  const redirected = await listRedirectedProductPaths();

  const drafts: { id: string; handle: string; title: string; status: string; productType: string | null; tags: string[] }[] = [];
  let after: string | null = null;
  do {
    await sleep();
    const d: {
      products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; handle: string; title: string; status: string; productType: string | null; tags: string[] }[] };
    } = await gql(
      `query($a:String){products(first:250,after:$a,query:"status:draft"){pageInfo{hasNextPage endCursor}nodes{id handle title status productType tags}}}`,
      { a: after },
    );
    drafts.push(...d.products.nodes);
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);

  const eligible = drafts.filter((p) => shouldRedirect(p));
  const missing = eligible.filter((p) => !redirected.has(`/products/${p.handle}`));
  const result: DraftRedirectReconcileResult = {
    dryRun: !apply, drafts: drafts.length, eligible: eligible.length,
    alreadyRedirected: eligible.length - missing.length, missing: missing.length,
    created: 0, planned: 0, failed: 0, deferred: Math.max(0, missing.length - cap), samples: [],
  };

  for (const p of missing.slice(0, cap)) {
    let out: DraftRedirectOutcome;
    try {
      await sleep();
      out = await ensureDraftRedirect(p.id, { apply });
    } catch (err) {
      out = { status: "failed", path: `/products/${p.handle}`, error: err instanceof Error ? err.message : String(err) };
    }
    if (out.status === "created") result.created++;
    else if (out.status === "planned") result.planned++;
    else if (out.status === "failed") result.failed++;
    if (result.samples.length < 30 || out.status === "failed") result.samples.push(out);
  }
  return result;
}
