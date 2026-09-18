#!/usr/bin/env tsx
/**
 * scripts/apply-pos1-corrections.mts
 *
 * Applies the 2026-09-17 regression's 32 confirmed non-compliant pos-1 corrections, the SAME
 * way the 2026-09-11/12 audit's 312 corrections were applied: queue the proposal in
 * image_review_queue (upsertImageReview), then apply it exactly as POST /api/images/review
 * {action:"approve"} would (moveImageToFirstPosition for a Shopify-gallery alternative,
 * uploadProductImageToFirstPosition for a feed-only one), then mark the row "applied"/"failed".
 *
 * THIS SCRIPT WRITES TO SHOPIFY. Explicitly authorized (2026-09-17/18 autonomous overnight
 * run). Every vision call is charged to the `maintenance` LLM pool (see image-compliance.ts).
 *
 * Modes:
 *   --dry-run     Re-audit each of the 32 with a real (uncached-if-stale) full gallery scan,
 *                 print whether a clean alternative is still proposed. Writes NOTHING.
 *   --apply       Same re-audit, then actually queue + apply each "fixable" result on Shopify.
 *   --sample N    After --apply, refetch N products' LIVE Shopify gallery and print pos-1,
 *                 to verify the write really landed (not just the internal review row).
 *
 * Run: node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/apply-pos1-corrections.mts --dry-run
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const APPLY = argv.includes("--apply");
const SAMPLE = (() => {
  const i = argv.indexOf("--sample");
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 0;
})();

const BUCKETS_FILE = ".tmp-imgaudit/pos1-regression-buckets.json";
const CHECKPOINT_FILE = ".tmp-imgaudit/pos1-regression.checkpoint.jsonl";
const LOG_FILE = ".tmp-imgaudit/pos1-corrections-applied.jsonl";

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function loadLib() {
  const [audit, db, shopify] = await Promise.all([
    import("@/lib/image-compliance-audit"),
    import("@/lib/database"),
    import("@/lib/shopify-client"),
  ]);
  return { audit, db, shopify };
}

interface CheckpointEntry {
  shopifyProductId: string;
  sku: string;
  name: string;
}

function loadTargetIds(): string[] {
  const buckets = JSON.parse(readFileSync(BUCKETS_FILE, "utf8")).buckets as Record<string, string[]>;
  const ids = new Set<string>();
  for (const list of Object.values(buckets)) for (const id of list) ids.add(id);
  return [...ids];
}

function loadCheckpointMeta(ids: string[]): Map<string, CheckpointEntry> {
  const wanted = new Set(ids);
  const out = new Map<string, CheckpointEntry>();
  for (const line of readFileSync(CHECKPOINT_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as CheckpointEntry;
      if (wanted.has(p.shopifyProductId) && !out.has(p.shopifyProductId)) out.set(p.shopifyProductId, p);
    } catch {
      /* skip truncated line */
    }
  }
  return out;
}

async function main() {
  if (!DRY_RUN && !APPLY && !SAMPLE) {
    console.log("usage: apply-pos1-corrections.mts --dry-run | --apply | --sample N");
    process.exit(1);
  }

  const lib = await loadLib();
  const ids = loadTargetIds();
  console.log(`target: ${ids.length} products (from ${BUCKETS_FILE})`);

  if (SAMPLE > 0) {
    const sampleIds = ids.slice(0, SAMPLE);
    for (const id of sampleIds) {
      const gallery = await lib.shopify.fetchProductImages(id);
      const pos1 = gallery[0];
      console.log(`  ${id}: live pos-1 = ${pos1 ? `id=${pos1.id} ${pos1.src}` : "(no images)"}`);
    }
    return;
  }

  const meta = loadCheckpointMeta(ids);

  type ResultRow = {
    id: string; sku: string; status: string; currentUrl: string; proposedUrl?: string;
    proposedImageId?: string | null; reason?: string; applyOutcome?: string; error?: string;
  };
  const results: ResultRow[] = [];

  for (const id of ids) {
    const m = meta.get(id);
    if (!m) {
      results.push({ id, sku: "?", status: "meta_missing", currentUrl: "" });
      continue;
    }
    let plan;
    try {
      plan = await lib.audit.auditProductPos1(
        { sku: m.sku, shopifyProductId: id, name: m.name },
        {
          useCache: true,
          budget: { left: 10 },
          includeFeedOnly: true,
          scanAllAlternatives: true,
          classifyOptions: { maintenance: true },
        },
      );
    } catch (err) {
      results.push({ id, sku: m.sku, status: "audit_error", currentUrl: "", error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const row: ResultRow = {
      id, sku: m.sku, status: plan.status, currentUrl: plan.currentUrl,
      proposedUrl: plan.proposedUrl, proposedImageId: plan.proposedImageId, reason: plan.proposedReason,
    };
    results.push(row);
    console.log(`  ${id} (${m.sku}): ${plan.status}${plan.status === "fixable" ? ` → proposed ${plan.proposedSource === "feed" ? "[feed]" : "[shopify]"} ${plan.proposedUrl}` : ""}`);

    if (!APPLY || plan.status !== "fixable") continue;

    try {
      const reviewId = await lib.db.upsertImageReview({
        shopifyProductId: id,
        sku: m.sku,
        name: m.name,
        currentUrl: plan.currentUrl,
        currentReason: plan.currentReason,
        proposedImageId: plan.proposedImageId ?? null,
        proposedUrl: plan.proposedUrl ?? "",
        proposedPosition: plan.proposedPosition ?? null,
        proposedReason: plan.proposedReason ?? "",
        source: plan.proposedSource ?? "shopify",
      });

      let newImageId: string | null = plan.proposedImageId ?? null;
      if (!plan.proposedImageId) {
        if (!plan.proposedUrl) throw new Error("no_clean_url_to_apply");
        const uploadedId = await lib.shopify.uploadProductImageToFirstPosition(id, plan.proposedUrl);
        if (!uploadedId) throw new Error("upload_not_confirmed");
        await lib.db.setImageReviewProposedImageId(reviewId, uploadedId);
        newImageId = uploadedId;
      } else {
        const verified = await lib.shopify.moveImageToFirstPosition(id, plan.proposedImageId);
        if (!verified) throw new Error("reorder_not_confirmed");
      }

      await lib.db.setImageReviewStatus(reviewId, "applied");
      row.applyOutcome = "applied";
      const record = {
        ts: new Date().toISOString(), shopifyProductId: id, sku: m.sku,
        before: { url: plan.currentUrl, reason: plan.currentReason },
        after: { imageId: newImageId, url: plan.proposedUrl, source: plan.proposedSource },
        reviewId,
      };
      ensureDir(LOG_FILE);
      appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, "utf8");
      console.log(`    ✓ applied — reviewId=${reviewId} newImageId=${newImageId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      row.applyOutcome = "failed";
      row.error = message;
      console.log(`    ✗ apply failed: ${message}`);
    }
  }

  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`\n${DRY_RUN ? "DRY-RUN" : "APPLY"} summary:`, byStatus);
  if (APPLY) {
    const applied = results.filter((r) => r.applyOutcome === "applied").length;
    const failed = results.filter((r) => r.applyOutcome === "failed").length;
    console.log(`applied: ${applied} · failed: ${failed} · not fixable (no_alternative/other): ${results.length - applied - failed}`);
  }

  writeFileSync(
    ".tmp-imgaudit/pos1-corrections-run.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), mode: APPLY ? "apply" : "dry-run", results }, null, 2),
  );
}

main();
