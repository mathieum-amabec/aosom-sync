#!/usr/bin/env tsx
// scripts/mass-import-from-batch.ts
//
// Mass-imports a curation batch (produced by curate-import-batch.js) into
// Shopify via the existing import pipeline. One-shot end-to-end:
//
//   batch JSON → queueForImport → generateContent → importToShopify
//
// Reuses src/lib/import-pipeline.ts — same code path as the /import UI's
// "Generate All Pending" button, just automated and headless. Every successful
// import triggers dual collection assignment (v0.1.7.0) + multi-photo social
// draft (v0.1.8.0) through the existing pipeline, no extra plumbing here.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/mass-import-from-batch.ts
//     → DRY RUN: prints plan + estimates, touches nothing
//
//   npx tsx --env-file=.env.local scripts/mass-import-from-batch.ts --execute
//     → REAL RUN: queues, generates content via Claude, pushes to Shopify
//
//   --limit=N       Take first N listings (default: all 240)
//   --spread        Take ceil(LIMIT/numCategories) from each category instead
//                   of the first LIMIT from the start of the batch. Used for
//                   diversified smoke tests that exercise every category pipeline.
//   --resume        Skip listings already imported (status='done' in import_jobs)
//   --batch=PATH    Use specific batch file (default: newest in data/curation/)
//
// Safety:
//   - Dry-run by default
//   - 2s delay between jobs (respects Claude + Shopify rate limits)
//   - Aborts after 5 consecutive failures
//   - Per-job log line + JSONL checkpoint to data/curation/import-log-<date>.jsonl
//   - Resume-safe via import_jobs table
//
// Expected runtime: ~20-25 min for 240 listings.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { queueForImport, generateContent, importToShopify } from "@/lib/import-pipeline";
import { getImportJobs as dbGetImportJobs } from "@/lib/database";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const RESUME = args.includes("--resume");
const SPREAD = args.includes("--spread");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const batchArg = args.find((a) => a.startsWith("--batch="));
const DELAY_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 5;

// ─── batch file resolution ──────────────────────────────────────────
interface BatchProduct {
  category: string;
  sku: string;
  base_sku: string;
  name: string;
  price: number;
  qty: number;
  product_type: string;
  image_count: number;
  score: number;
  variant_count: number;
  variant_skus: string[];
}

interface BatchFile {
  generated_at: string;
  pool_size: number;
  total_selected: number;
  products: BatchProduct[];
}

function findLatestBatch(): string {
  const dir = path.resolve(__dirname, "..", "data", "curation");
  if (!fs.existsSync(dir)) {
    throw new Error(`No curation dir at ${dir}. Run scripts/curate-import-batch.js first.`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("batch-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) {
    throw new Error("No batch-*.json found. Run scripts/curate-import-batch.js first.");
  }
  return path.join(dir, files[0]);
}

const batchPath = batchArg
  ? path.resolve(batchArg.split("=")[1])
  : findLatestBatch();

if (!fs.existsSync(batchPath)) {
  console.error(`ERROR: batch file not found: ${batchPath}`);
  process.exit(1);
}

const batch: BatchFile = JSON.parse(fs.readFileSync(batchPath, "utf8"));
console.log(`[mass-import] Loaded batch: ${path.relative(process.cwd(), batchPath)}`);
console.log(`[mass-import] Generated: ${batch.generated_at}`);
console.log(`[mass-import] Total listings in batch: ${batch.products.length}`);

// Apply limit + optional spread.
// Default: take first LIMIT listings (batch is already ordered by category priority).
// --spread: take ceil(LIMIT / numCategories) from each category for a diversified
//           smoke test that exercises every category pipeline at least once.
let listings: BatchProduct[];
if (SPREAD) {
  const byCat: Record<string, BatchProduct[]> = {};
  for (const p of batch.products) (byCat[p.category] ??= []).push(p);
  const numCats = Object.keys(byCat).length;
  const perCat = LIMIT === Infinity ? Infinity : Math.ceil(LIMIT / numCats);
  listings = [];
  for (const cat of Object.keys(byCat)) {
    listings.push(...byCat[cat].slice(0, perCat));
  }
  console.log(`[mass-import] Processing ${listings.length} listings (--spread: ${perCat === Infinity ? "all" : perCat} per category × ${numCats} categories)`);
} else {
  listings = batch.products.slice(0, LIMIT);
  console.log(`[mass-import] Processing ${listings.length} listings${LIMIT !== Infinity ? ` (--limit=${LIMIT})` : ""}`);
}

// ─── resume filter ──────────────────────────────────────────────────
async function filterAlreadyImported(targets: BatchProduct[]): Promise<BatchProduct[]> {
  if (!RESUME) return targets;
  console.log(`[mass-import] --resume: checking import_jobs for existing done status...`);
  const allJobs = await dbGetImportJobs();
  const doneGroupKeys = new Set(
    allJobs.filter((j: Record<string, unknown>) => j.status === "done").map((j: Record<string, unknown>) => j.group_key as string)
  );
  const filtered = targets.filter((p) => !doneGroupKeys.has(p.base_sku));
  const skipped = targets.length - filtered.length;
  if (skipped > 0) console.log(`[mass-import] --resume: skipping ${skipped} already-done listings`);
  return filtered;
}

// ─── cost / time estimate ───────────────────────────────────────────
function printEstimate(n: number) {
  const claudeCalls = n * 2 + n * 2; // generateContent FR+EN + triggerNewProduct FR+EN
  const shopifyCalls = n * 2; // createProduct + collects (main + sub, minus dedup)
  const perJobSeconds = 2 /* Claude */ + 1 /* Shopify */ + DELAY_MS / 1000;
  const totalSeconds = 60 + n * perJobSeconds; // +60s for catalog fetch
  const mins = Math.round(totalSeconds / 60);
  console.log("");
  console.log(`ESTIMATES (for ${n} listings):`);
  console.log(`  Claude API calls: ~${claudeCalls} (${n * 2} import content + ${n * 2} social drafts)`);
  console.log(`  Shopify API calls: ~${shopifyCalls} (products + collects)`);
  console.log(`  Delay between jobs: ${DELAY_MS / 1000}s`);
  console.log(`  Estimated runtime: ~${mins} min`);
  console.log("");
}

// ─── per-job log ────────────────────────────────────────────────────
const date = new Date().toISOString().slice(0, 10);
const logPath = path.resolve(__dirname, "..", "data", "curation", `import-log-${date}.jsonl`);
function log(entry: Record<string, unknown>) {
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// ─── main ───────────────────────────────────────────────────────────
(async () => {
  const targets = await filterAlreadyImported(listings);

  if (targets.length === 0) {
    console.log("[mass-import] Nothing to do — all listings already imported.");
    process.exit(0);
  }

  printEstimate(targets.length);

  if (!EXECUTE) {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("DRY RUN — no Turso or Shopify writes. Use --execute to run for real.");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("");
    console.log("Category breakdown:");
    const byCat: Record<string, number> = {};
    for (const p of targets) byCat[p.category] = (byCat[p.category] || 0) + 1;
    for (const [k, v] of Object.entries(byCat)) {
      console.log(`  ${k.padEnd(20)} ${v}`);
    }
    console.log("");
    console.log("First 5 listings to be queued:");
    targets.slice(0, 5).forEach((p, i) => {
      const name = (p.name || "").slice(0, 50);
      const vs = p.variant_count > 1 ? ` (+${p.variant_count - 1} variants)` : "";
      console.log(`  ${i + 1}. [${p.sku}]${vs} ${name} — ${p.price.toFixed(2)}$`);
    });
    console.log("");
    console.log("Run again with --execute to start the real import.");
    process.exit(0);
  }

  // ─── EXECUTE ──────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("EXECUTING — queueing, generating, and pushing to Shopify.");
  console.log("═══════════════════════════════════════════════════════════════");

  // Collect ALL variant SKUs across all target listings (variant-merger re-groups them)
  const allVariantSkus: string[] = [];
  for (const p of targets) {
    for (const sku of p.variant_skus) allVariantSkus.push(sku);
  }
  console.log(`[mass-import] Flattened to ${allVariantSkus.length} raw SKUs (will be re-grouped by variant-merger)`);

  console.log(`[mass-import] Fetching Aosom catalog + queuing ${targets.length} listings...`);
  log({ event: "queue_start", targets: targets.length, variant_skus: allVariantSkus.length });

  const queueStart = Date.now();
  const jobs = await queueForImport(allVariantSkus);
  const queueMs = Date.now() - queueStart;
  console.log(`[mass-import] Queued ${jobs.length} jobs in ${(queueMs / 1000).toFixed(1)}s`);
  log({ event: "queue_done", queued: jobs.length, elapsed_ms: queueMs });

  if (jobs.length === 0) {
    console.error("[mass-import] ERROR: queueForImport returned 0 jobs. Check SKU matching.");
    process.exit(1);
  }
  if (jobs.length !== targets.length) {
    console.warn(`[mass-import] WARN: queued ${jobs.length} jobs but expected ${targets.length}. Some SKUs may have been filtered by the CSV fetcher.`);
  }

  // ─── process each job ──────────────────────────────────────────────
  let okCount = 0;
  let errCount = 0;
  let consecutiveFailures = 0;
  const runStart = Date.now();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const tag = `[${i + 1}/${jobs.length}] ${job.groupKey}`;
    const jobStart = Date.now();

    try {
      process.stdout.write(`${tag} generating...`);
      await generateContent(job.id);
      process.stdout.write(` pushing...`);
      const imported = await importToShopify(job.id);
      const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
      console.log(` ✓ shopifyId=${imported.shopifyId} (${elapsed}s)`);
      log({ event: "job_done", index: i + 1, group: job.groupKey, job_id: job.id, shopify_id: imported.shopifyId, elapsed_ms: Date.now() - jobStart });
      okCount++;
      consecutiveFailures = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(` ✗ ERROR: ${msg}`);
      log({ event: "job_error", index: i + 1, group: job.groupKey, job_id: job.id, error: msg });
      errCount++;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`\n[mass-import] ABORTING — ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Check crédits Claude / Shopify health / logs.`);
        log({ event: "abort_consecutive_failures", index: i + 1, count: consecutiveFailures });
        break;
      }
    }

    // Delay between jobs to respect rate limits (skip after last one)
    if (i < jobs.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // ─── final summary ─────────────────────────────────────────────────
  const totalSec = Math.round((Date.now() - runStart) / 1000);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("MASS IMPORT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Listings processed: ${okCount + errCount} / ${jobs.length}`);
  console.log(`  Successful:         ${okCount}`);
  console.log(`  Failed:             ${errCount}`);
  console.log(`  Runtime:            ${Math.floor(totalSec / 60)}m ${totalSec % 60}s`);
  console.log(`  Log file:           ${path.relative(process.cwd(), logPath)}`);
  console.log("═══════════════════════════════════════════════════════════════");

  log({
    event: "run_complete",
    ok: okCount,
    err: errCount,
    total: jobs.length,
    elapsed_s: totalSec,
  });

  process.exit(errCount > 0 ? 1 : 0);
})().catch((err) => {
  console.error("[mass-import] FATAL:", err);
  log({ event: "fatal", error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
