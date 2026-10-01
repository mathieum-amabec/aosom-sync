/**
 * Loads the three sources (import_jobs, products, Shopify) and classifies every import job —
 * see import-job-state.ts for the rules. One Shopify pass (~8 GraphQL pages) + chunked
 * Turso reads of only the jobs' SKUs.
 */
import { getImportJobsList, type ImportJob } from "./import-pipeline";
import { getFeedRowsForSkus } from "./database";
import { fetchAllProductStates } from "./shopify-client";
import {
  classifyImportJob,
  planImportJobFix,
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

  return jobs.map((job) => {
    const skus = jobSkus(job);
    const input: JobInput = { status: job.status, shopifyId: job.shopifyId, error: job.error, skus };
    const feedRows = skus.map((s) => bySku.get(s)).filter((r): r is FeedRow => !!r);
    return { job, input, state: classifyImportJob(input, feedRows, states, nowSecs) };
  });
}

/** The import_jobs corrections that would make the queue agree with Shopify (dry-run input). */
export function planImportJobFixes(classified: ClassifiedImportJob[]): ImportJobFix[] {
  return classified
    .map((c) => planImportJobFix(c.job.id, c.input, c.state))
    .filter((f): f is ImportJobFix => f !== null);
}
