// One-off cleanup: make import_jobs agree with Shopify (see src/lib/import-job-state.ts).
//   - "pending" / "reviewing" / "error" jobs whose product already exists on Shopify → done
//   - jobs pointing at a deleted Shopify product → relinked to the SKU's current product,
//     or back to "pending" when nothing replaced it
// Only rewrites the queue's bookkeeping — never creates, edits or deletes anything on Shopify.
// needs_review jobs are never touched.
//
// DRY RUN by default. --apply writes.
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/cleanup-import-jobs.mts [--apply]
import * as svcNs from "../src/lib/import-job-state-service";
import * as dbNs from "../src/lib/database";

// tsx may surface a CommonJS module's named exports under `default`.
type Svc = typeof import("../src/lib/import-job-state-service");
type Db = typeof import("../src/lib/database");
const svc: Svc = (svcNs as unknown as { default?: Svc }).default ?? (svcNs as unknown as Svc);
const db: Db = (dbNs as unknown as { default?: Db }).default ?? (dbNs as unknown as Db);

const APPLY = process.argv.includes("--apply");

const classified = await svc.classifyAllImportJobs();
const fixes = svc.planImportJobFixes(classified);

const summary = new Map<string, number>();
for (const f of fixes) {
  const key = `${f.from.status} → ${f.set.status ?? f.from.status}${"shopify_id" in f.set ? (f.set.shopify_id ? " (relié)" : " (lien retiré)") : ""}`;
  summary.set(key, (summary.get(key) ?? 0) + 1);
}
console.log(`jobs: ${classified.length} — corrections: ${fixes.length}`);
for (const [k, n] of [...summary].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
for (const f of fixes.filter((x) => "shopify_id" in x.set)) console.log(`  ${f.jobId}: ${f.why}`);

if (!APPLY) {
  console.log("DRY RUN — nothing written. --apply to write.");
  process.exit(0);
}

let written = 0;
for (const f of fixes) {
  await db.updateImportJob(f.jobId, f.set);
  written++;
}
console.log(`applied ${written}/${fixes.length}`);
