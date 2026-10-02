/**
 * The set of Shopify product ids that carry the `lifestyle-verified` tag.
 *
 * WHY THIS EXISTS (2026-10-02)
 * The stock-highlight generator used to draw 15 random eligible SKUs and only THEN ask
 * Shopify, one product at a time, whether each was verified. In a category where few
 * fiches are verified that blind draw misses: "Bureau & Télétravail" had 198 eligible
 * SKUs but only 17 verified fiches, and the trend trial pinned 4 unverified trending SKUs
 * at the head of every sample. Measured odds of a miss: ~5% on the first draft, climbing
 * with every post as the few verified fiches entered the repost cooldown.
 *
 * Knowing the verified set up front lets the sampler draw ONLY among postable products,
 * so a category fails only when it truly has nothing left to post.
 *
 * One paged GraphQL search (~700 ids, 3 pages), cached 10 minutes. Returns null on any
 * failure (no token, network, GraphQL error): callers then fall back to the old blind
 * draw, which still works — just less reliably.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { env } from "@/lib/config";

const TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 20;

let cached: { ids: Set<string>; expiry: number } | null = null;

type Fetcher = () => Promise<Set<string> | null>;

async function fetchVerifiedIds(): Promise<Set<string> | null> {
  if (!env.hasShopifyToken) return null;
  const ids = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await shopifyFetch("/graphql.json", {
        method: "POST",
        body: JSON.stringify({
          query: `query($c:String){products(first:250,after:$c,query:"tag:lifestyle-verified"){pageInfo{hasNextPage endCursor} nodes{legacyResourceId}}}`,
          variables: { c: cursor },
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: {
          products?: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ legacyResourceId: string }>;
          };
        };
        errors?: unknown;
      };
      const products = json.data?.products;
      if (!products || json.errors) return null;
      for (const n of products.nodes) ids.add(String(n.legacyResourceId));
      if (!products.pageInfo.hasNextPage) return ids;
      cursor = products.pageInfo.endCursor;
    }
    return ids;
  } catch {
    return null;
  }
}

let fetcher: Fetcher = fetchVerifiedIds;

/** Verified Shopify product ids (cached 10 min), or null when Shopify can't say. */
export async function getLifestyleVerifiedProductIds(): Promise<Set<string> | null> {
  if (cached && cached.expiry > Date.now()) return cached.ids;
  const ids = await fetcher();
  // A failure is not cached: the next call retries instead of serving a stale "unknown".
  if (ids) cached = { ids, expiry: Date.now() + TTL_MS };
  return ids;
}

/** Test-only: swap the fetcher (null restores the real one) and drop the cache. */
export function __setVerifiedSetFetcherForTests(fn: Fetcher | null): void {
  fetcher = fn ?? fetchVerifiedIds;
  cached = null;
}
