/**
 * Loads the three sources (import_jobs, products, Shopify) and classifies every import job —
 * see import-job-state.ts for the rules. One Shopify pass (~8 GraphQL pages) + chunked
 * Turso reads of the jobs' SKUs, plus a reverse-lookup pass once each job's Shopify id is
 * known (see classifyAllImportJobs's comment on why).
 */
import { getImportJobsList, type ImportJob } from "./import-pipeline";
import { getFeedRowsForSkus, getFeedRowsByShopifyIds } from "./database";
import { fetchAllProductStates } from "./shopify-client";
import {
  classifyImportJob,
  planImportJobFix,
  resolveShopifyId,
  type FeedRow,
  type ImportJobFix,
  type ImportJobState,
  type JobInput,
} from "./import-job-state";

export interface ClassifiedImportJob {
  job: ImportJob;
  input: JobInput;
  state: ImportJobState;
}

function jobSkus(job: ImportJob): string[] {
  return (job.product?.variants ?? []).map((v) => v.sku).filter(Boolean);
}

export async function classifyAllImportJobs(nowSecs = Math.floor(Date.now() / 1000)): Promise<ClassifiedImportJob[]> {
  const jobs = await getImportJobsList();
  const [rows, states] = await Promise.all([
    getFeedRowsForSkus(jobs.flatMap(jobSkus)),
    fetchAllProductStates(),
  ]);
  const bySku = new Map<string, FeedRow>(rows.map((r) => [r.sku, r]));

  const prepared = jobs.map((job) => {
    const skus = jobSkus(job);
    const input: JobInput = { status: job.status, shopifyId: job.shopifyId, error: job.error, skus };
    const frozenFeedRows = skus.map((s) => bySku.get(s)).filter((r): r is FeedRow => !!r);
    return { job, input, frozenFeedRows, shopifyId: resolveShopifyId(input, frozenFeedRows, states) };
  });

  // Re-derive feed presence from whatever SKU CURRENTLY carries the Shopify link, instead of
  // the SKU string the import recorded at the time — Aosom routinely corrects a SKU's
  // colour/variant suffix after we've already imported it (confirmed: `84B-206BU` became
  // `84B-206BK`, same product, still selling normally). The frozen snapshot alone read that
  // as "gone from the feed" for 10 products that were never actually discontinued — a false
  // positive, not a real one (2026-09-30 investigation). Falls back to the frozen snapshot
  // when nothing is currently linked to the resolved id (e.g. before reconcileProductShopifyLinks
  // has caught up), so a genuinely orphaned link degrades to today's existing behaviour.
  const resolvedIds = prepared.map((p) => p.shopifyId).filter((id): id is string => !!id);
  const byShopifyId = await getFeedRowsByShopifyIds(resolvedIds);

  return prepared.map(({ job, input, frozenFeedRows, shopifyId }) => {
    const current = shopifyId ? byShopifyId.get(shopifyId) : undefined;
    const feedRows: FeedRow[] = current && current.length > 0
      ? current.map((r) => ({ ...r, shopifyProductId: shopifyId as string }))
      : frozenFeedRows;
    return { job, input, state: classifyImportJob(input, feedRows, states, nowSecs) };
  });
}

/** The import_jobs corrections that would make the queue agree with Shopify (dry-run input). */
export function planImportJobFixes(classified: ClassifiedImportJob[]): ImportJobFix[] {
  return classified
    .map((c) => planImportJobFix(c.job.id, c.input, c.state))
    .filter((f): f is ImportJobFix => f !== null);
}
