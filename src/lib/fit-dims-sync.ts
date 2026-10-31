/**
 * Keep the `custom.lc_dims` metafield (PDP "Est-ce que ça va entrer chez moi ?" checker, fit-dims.ts) in step with the
 * Aosom feed for EVERY Shopify product — Mat, 2026-10-20: "Assure-toi que les produits futurs vont avoir les dimensions."
 *
 * New imports already get the metafield at creation (createShopifyProduct). This daily pass is the safety net for the
 * rest: jobs queued before the feed carried unit strings, products created by other paths, and feed corrections. It
 * writes only products whose value changed (sorted JSON compare), so a normal day writes a handful at most; capped per
 * run. Products with no SKU in the feed (Costway…) and products whose page states another size are left alone.
 */
import { fetchAosomCatalog } from "./csv-fetcher";
import { shopifyFetch } from "./shopify-client";
import { buildFitDims, checkAgainstPage, serializeFitDims, FIT_DIMS_KEY, FIT_DIMS_NAMESPACE } from "./fit-dims";
import type { AosomProduct } from "@/types/aosom";

export const FIT_DIMS_MAX_WRITES_PER_RUN = 500;
const BATCH = 25;

export interface FitDimsPlanItem {
  id: string;
  handle: string;
  status: string;
  value: string;
  skus: number;
  matched: number;
}

export interface FitDimsSyncResult {
  dryRun: boolean;
  feedSkus: number;
  products: number;
  toWrite: number;
  unchanged: number;
  noFeedMatch: number;
  feedButNoSize: number;
  pageSizeConflict: number;
  /** Conflicting products that still carry an older (wrong) value, removed on apply. */
  staleToRemove: number;
  removed: number;
  written: number;
  failed: number;
  /** Planned writes beyond the per-run cap, picked up by the next run. */
  deferred: number;
  plan: FitDimsPlanItem[];
  conflicts: string[];
}

interface ProductNode {
  id: string;
  handle: string;
  status: string;
  description: string;
  variants: { nodes: { sku: string | null; title: string }[] };
  metafield: { value: string } | null;
}

type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<{ data?: T; errors?: { message: string }[] }>;

const shopifyGql: Gql = async (query, variables) => {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
  return res.json();
};

/** Compare every product against the feed; with `apply`, write the changed ones (up to `limit`). */
export async function syncFitDims(
  opts: { apply?: boolean; limit?: number } = {},
  deps: { feed?: () => Promise<AosomProduct[]>; gql?: Gql } = {},
): Promise<FitDimsSyncResult> {
  const gql = deps.gql ?? shopifyGql;
  const feed = await (deps.feed ?? fetchAosomCatalog)();
  const bySku = new Map(feed.map((p) => [p.sku, p]));

  const products: ProductNode[] = [];
  let cursor: string | null = null;
  do {
    const r: { data?: { products: { nodes: ProductNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }; errors?: { message: string }[] } = await gql(
      `query($after: String) { products(first: 100, after: $after) {
        nodes { id handle status description variants(first: 100) { nodes { sku title } } metafield(namespace: "${FIT_DIMS_NAMESPACE}", key: "${FIT_DIMS_KEY}") { value } }
        pageInfo { hasNextPage endCursor } } }`,
      { after: cursor },
    );
    if (!r.data) throw new Error(`products query failed: ${JSON.stringify(r.errors).slice(0, 300)}`);
    products.push(...r.data.products.nodes);
    cursor = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (cursor);

  const plan: FitDimsPlanItem[] = [];
  const conflicts: string[] = [];
  const stale: { id: string; handle: string }[] = [];
  let noFeedMatch = 0, feedButNoSize = 0, unchanged = 0;
  for (const p of products) {
    const skus = p.variants.nodes.map((v) => (v.sku || "").trim()).filter(Boolean);
    const rows = skus.flatMap((sku) => {
      const f = bySku.get(sku);
      return f?.dimensionsRaw ? [{ sku, ...f.dimensionsRaw, boxSize: f.boxSize }] : [];
    });
    if (rows.length === 0) { noFeedMatch++; continue; }
    const built = buildFitDims(rows);
    if (!built) { feedButNoSize++; continue; }
    // The page size can live in the description or only in a variant title ("Gris / 103 x 71 x 69 cm"); without
    // the titles, 14 feed sizes that were really inches passed as cm (2026-10-31: a 182 cm kayak shown at 72 cm).
    const pageText = [p.description, ...p.variants.nodes.map((v) => v.title)].join("\n");
    const dims = checkAgainstPage(built, pageText);
    if (!dims) {
      conflicts.push(p.handle);
      // A value written before this check existed is wrong too: remove it so the checker hides instead of lying.
      if (p.metafield) stale.push({ id: p.id, handle: p.handle });
      continue;
    }
    const value = serializeFitDims(dims);
    if (p.metafield?.value === value) { unchanged++; continue; }
    plan.push({ id: p.id, handle: p.handle, status: p.status, value, skus: skus.length, matched: Object.keys(dims.s).length });
  }

  const result: FitDimsSyncResult = {
    dryRun: !opts.apply,
    feedSkus: feed.length,
    products: products.length,
    toWrite: plan.length,
    unchanged,
    noFeedMatch,
    feedButNoSize,
    pageSizeConflict: conflicts.length,
    staleToRemove: stale.length,
    removed: 0,
    written: 0,
    failed: 0,
    deferred: 0,
    plan,
    conflicts,
  };
  if (!opts.apply) return result;

  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    try {
      const r = await gql<{ metafieldsDelete: { userErrors: { field: string[]; message: string }[] } }>(
        `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`,
        { m: batch.map((x) => ({ ownerId: x.id, namespace: FIT_DIMS_NAMESPACE, key: FIT_DIMS_KEY })) },
      );
      const errs = r.data?.metafieldsDelete.userErrors ?? [{ field: [], message: JSON.stringify(r.errors) }];
      if (errs.length) { result.failed += batch.length; console.error(`[fit-dims] delete failed: ${JSON.stringify(errs).slice(0, 300)}`); continue; }
      result.removed += batch.length;
    } catch (err) {
      result.failed += batch.length;
      console.error(`[fit-dims] delete error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cap = Math.min(opts.limit ?? FIT_DIMS_MAX_WRITES_PER_RUN, FIT_DIMS_MAX_WRITES_PER_RUN);
  const todo = plan.slice(0, cap);
  result.deferred = plan.length - todo.length;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const r = await gql<{ metafieldsSet: { userErrors: { field: string[]; message: string }[] } }>(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
        { m: batch.map((x) => ({ ownerId: x.id, namespace: FIT_DIMS_NAMESPACE, key: FIT_DIMS_KEY, type: "json", value: x.value })) },
      );
      const errs = r.data?.metafieldsSet.userErrors ?? [{ field: [], message: JSON.stringify(r.errors) }];
      if (errs.length) { result.failed += batch.length; console.error(`[fit-dims] batch failed: ${JSON.stringify(errs).slice(0, 300)}`); continue; }
      result.written += batch.length;
    } catch (err) {
      result.failed += batch.length;
      console.error(`[fit-dims] batch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
