/**
 * Automatic pos-1 image compliance — the daily-sync guard.
 *
 * After a sync writes products, this pass picks the newest never-checked products that are
 * live on Shopify and asks the shared audit engine (image-compliance-audit.ts) whether the
 * pos-1 (featured) image carries a marketing/measurement overlay. What happens next depends
 * on the configured MODE:
 *
 *   • "hybrid" (default since v0.5.92.0) — an OBVIOUS swap applies itself; an AMBIGUOUS one
 *     goes to `image_review_queue` for a human. "Obvious" means the winner is unique in its
 *     background class and the model did not hedge — see `classifySwapDecision`. This is the
 *     mode that keeps a queue from silently growing to 312 rows again while still refusing to
 *     make an editorial choice on its own.
 *     ⚠️ It costs more vision calls than the others: deciding obvious-vs-ambiguous requires
 *     scanning the WHOLE image set, not stopping at the first clean photo.
 *   • "queue"  — every proposal goes to `image_review_queue`. NOTHING is written to Shopify.
 *     This is the mode the catalogue cleanup ran under.
 *   • "auto"   — legacy behaviour: swap immediately (the mechanism of the 141 manual swaps),
 *     with no obvious/ambiguous distinction at all.
 *   • "off"    — no-op.
 *
 * A feed-only candidate is NEVER applied unattended, in any mode: promoting it means uploading
 * a new photo onto a live product, which is well past "reorder what is already there". Hybrid
 * queues those even when the set is otherwise obvious.
 *
 * Set it with the `image_compliance_mode` setting; no deploy needed to change it.
 *
 * A product whose pos-1 is dirty but whose WHOLE image set is dirty too is never queued —
 * there is nothing better to offer — it is logged and marked checked so it stops consuming
 * budget. Everything about this pass is best-effort: any failure is logged and swallowed so
 * it can never fail an otherwise-successful sync.
 *
 * Cost guard: at most `maxClassifications` Claude vision calls per run (default 20), spread
 * across pos-1 checks AND the gallery scan for a replacement. Candidates are ordered
 * newest-import-first (products.created_at DESC), so fresh imports are prioritized.
 */
import { auditProductPos1, type Pos1AuditPlan } from "./image-compliance-audit";
import { moveImageToFirstPosition } from "./shopify-client";
import {
  getImageComplianceCandidates,
  getFeedImagesForProducts,
  markImageChecked,
  addSyncLogsBatch,
  upsertImageReview,
  getSetting,
} from "./database";
import { env } from "./config";
import type { SyncLogEntry } from "@/types/sync";

export const DEFAULT_MAX_CLASSIFICATIONS = 20;

export type ImageComplianceMode = "queue" | "auto" | "hybrid" | "off";
export const DEFAULT_IMAGE_COMPLIANCE_MODE: ImageComplianceMode = "hybrid";

/** Read the mode from settings, falling back to the default on an unset/unknown value. */
export async function getImageComplianceMode(): Promise<ImageComplianceMode> {
  try {
    const raw = (await getSetting("image_compliance_mode"))?.trim().toLowerCase();
    if (raw === "queue" || raw === "auto" || raw === "hybrid" || raw === "off") return raw;
  } catch {
    // Settings unreachable — fall through to the default rather than skipping the pass.
  }
  return DEFAULT_IMAGE_COMPLIANCE_MODE;
}

export interface ImageComplianceResult {
  mode: ImageComplianceMode;
  /** Products whose pos-1 image was classified. */
  checked: number;
  /** pos-1 already compliant (no marketing overlay). */
  compliant: number;
  /** pos-1 non-compliant (marketing overlay detected). */
  nonCompliant: number;
  /** Non-compliant products whose proposed swap is awaiting approval in /images ("queue"). */
  queued: number;
  /** Non-compliant products where pos-1 was swapped on Shopify ("auto" only). */
  swapped: number;
  /** Non-compliant products where the WHOLE image set was scanned and no clean image exists. */
  noAlternative: number;
  /** Non-compliant products left unresolved because the budget ran out mid-scan — NOT stamped
   * checked, so a future run finishes the scan. */
  deferred: number;
  /** Total Claude vision calls consumed (capped at maxClassifications). */
  classifications: number;
  /** Per-product / per-image errors (non-fatal). */
  errors: number;
}

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "image-compliance", msg, ...extra }));
}

const emptyResult = (mode: ImageComplianceMode): ImageComplianceResult => ({
  mode, checked: 0, compliant: 0, nonCompliant: 0, queued: 0, swapped: 0,
  noAlternative: 0, deferred: 0, classifications: 0, errors: 0,
});

/**
 * Run one pos-1 compliance pass. Returns counts; never throws (best-effort).
 */
export async function runImageCompliance(opts: {
  syncRunId: string;
  maxClassifications?: number;
  /** Override the configured mode (tests, manual runs). */
  mode?: ImageComplianceMode;
}): Promise<ImageComplianceResult> {
  const mode = opts.mode ?? (await getImageComplianceMode());
  const result = emptyResult(mode);
  const maxClassifications = opts.maxClassifications ?? DEFAULT_MAX_CLASSIFICATIONS;
  if (mode === "off") {
    log("mode=off — skipping image compliance");
    return result;
  }
  if (maxClassifications <= 0) return result;

  // Without a Shopify token every image fetch returns [] — which would otherwise mark each
  // candidate "checked" without ever classifying it, permanently skipping the product. Bail
  // before touching the checked flag so a token-less/misconfigured run is a true no-op.
  if (!env.hasShopifyToken) {
    log("no Shopify token — skipping image compliance");
    return result;
  }

  // Never classify more products than the budget allows even in the best case (1 call each).
  let candidates;
  try {
    candidates = await getImageComplianceCandidates(maxClassifications);
  } catch (err) {
    log("candidate query failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    return result;
  }
  if (candidates.length === 0) {
    log("no candidates — nothing to check");
    return result;
  }

  // The audit also considers Aosom feed photos absent from the Shopify gallery, so it needs
  // products.image1..7. One extra query for the whole batch, joined by Shopify product id.
  let feedByProduct = new Map<string, string[]>();
  try {
    feedByProduct = await getFeedImagesForProducts(candidates.map((c) => c.shopifyProductId));
  } catch (err) {
    // Non-fatal: without the feed the audit simply falls back to the Shopify gallery alone.
    log("feed image lookup failed (non-fatal) — gallery-only scan", { error: err instanceof Error ? err.message : String(err) });
  }

  log(`starting: ${candidates.length} candidate(s), budget ${maxClassifications}, mode ${mode}`);

  const budget = { left: maxClassifications };
  const logEntries: Omit<SyncLogEntry, "id">[] = [];
  const now = new Date().toISOString();

  // Stamp ONE product checked as soon as it's genuinely resolved (compliant / queued /
  // swapped / whole-set-had-no-clean-image). Per-product (≤20 tiny UPDATEs/run) so a mid-run
  // timeout can't lose the idempotency flag and re-burn the budget next run. Products left
  // UNSTAMPED on failure/deferral are deliberately retried by a future run — better a couple
  // of wasted calls than silently leaving a marketing overlay live at pos-1.
  async function markResolved(productId: string): Promise<void> {
    try {
      await markImageChecked([productId]);
    } catch (err) {
      log("markImageChecked failed (non-fatal)", { product_id: productId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const c of candidates) {
    if (budget.left <= 0) break;

    let plan: Pos1AuditPlan;
    try {
      plan = await auditProductPos1(
        { sku: c.sku, shopifyProductId: c.shopifyProductId, name: c.name, feedImages: feedByProduct.get(c.shopifyProductId) ?? [] },
        // hybrid has to see the WHOLE set: "is this the only clean photo, or one of several
        // equally good ones" is the entire obvious/ambiguous question, and the default scan
        // stops at the first clean image. The other modes keep the cheaper partial scan.
        { budget, scanAllAlternatives: mode === "hybrid" },
      );
    } catch (err) {
      // Unresolved — leave UNSTAMPED so it's retried next run.
      result.errors++;
      log("audit threw (non-fatal) — will retry next run", { sku: c.sku, product_id: c.shopifyProductId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    result.classifications += plan.calls;

    switch (plan.status) {
      case "no_images":
        // Nothing to classify — resolved, don't retry every run.
        await markResolved(c.shopifyProductId);
        break;

      case "compliant":
        result.checked++;
        result.compliant++;
        await markResolved(c.shopifyProductId);
        break;

      case "fixable": {
        result.checked++;
        result.nonCompliant++;

        // hybrid: an OBVIOUS swap applies itself, an ambiguous one goes to a human. Anything
        // the audit could not label (no full scan, or a partial one) is treated as ambiguous —
        // the safe direction is always "ask", never "guess and write to a live product".
        const queueIt = mode === "queue" || (mode === "hybrid" && plan.decision !== "obvious");

        if (queueIt) {
          // Human-in-the-loop: record the proposal, write NOTHING to Shopify.
          try {
            await upsertImageReview({
              shopifyProductId: c.shopifyProductId,
              sku: c.sku,
              name: c.name,
              currentUrl: plan.currentUrl,
              currentReason: plan.currentReason,
              proposedImageId: plan.proposedImageId ?? null,
              proposedUrl: plan.proposedUrl ?? "",
              proposedPosition: plan.proposedPosition ?? null,
              proposedReason: plan.proposedReason ?? "",
              source: plan.proposedSource ?? "shopify",
            });
            result.queued++;
            await markResolved(c.shopifyProductId);
            log("queued for approval", {
              sku: c.sku, product_id: c.shopifyProductId, proposed_image_id: plan.proposedImageId,
              was_position: plan.proposedPosition,
              // In hybrid this is the interesting half: WHY a human has to look at this one.
              ...(mode === "hybrid" ? { decision: plan.decision ?? "non classé", why: plan.decisionReason, clean_alternatives: plan.cleanAlternatives } : {}),
            });
            logEntries.push({
              syncRunId: opts.syncRunId,
              timestamp: now,
              shopifyProductId: c.shopifyProductId,
              sku: c.sku,
              action: "update",
              field: "images",
              oldValue: `pos-1 non conforme: ${plan.currentUrl.split("?")[0]} — ${plan.currentReason}`.slice(0, 255),
              newValue: `EN ATTENTE D'APPROBATION (/images) — remplacement proposé: ${(plan.proposedUrl ?? "").split("?")[0]}`.slice(0, 255),
            });
          } catch (err) {
            // Left UNSTAMPED so the next run re-proposes it.
            result.errors++;
            log("queueing failed (non-fatal) — will retry next run", { sku: c.sku, error: err instanceof Error ? err.message : String(err) });
          }
          break;
        }

        // mode "auto", or "hybrid" on an OBVIOUS case: apply the swap straight away — but only a photo Shopify already
        // holds can be promoted by a reorder. A feed-only candidate would need an upload
        // first, which auto mode deliberately does not do (it adds an image to a live
        // product, well past "reorder what is already there"). Queue it for a human instead.
        if (!plan.proposedImageId) {
          try {
            await upsertImageReview({
              shopifyProductId: c.shopifyProductId,
              sku: c.sku,
              name: c.name,
              currentUrl: plan.currentUrl,
              currentReason: plan.currentReason,
              proposedImageId: null,
              proposedUrl: plan.proposedUrl ?? "",
              proposedPosition: null,
              proposedReason: plan.proposedReason ?? "",
              source: "feed",
            });
            result.queued++;
            await markResolved(c.shopifyProductId);
            log("clean image exists only in the Aosom feed — queued for approval (needs upload)", { sku: c.sku, product_id: c.shopifyProductId });
          } catch (err) {
            result.errors++;
            log("queueing feed-only proposal failed (non-fatal)", { sku: c.sku, error: err instanceof Error ? err.message : String(err) });
          }
          break;
        }

        try {
          const verified = await moveImageToFirstPosition(c.shopifyProductId, plan.proposedImageId);
          if (verified) {
            result.swapped++;
            await markResolved(c.shopifyProductId);
            log("swapped pos-1", { sku: c.sku, product_id: c.shopifyProductId, new_image_id: plan.proposedImageId, was_position: plan.proposedPosition });
            logEntries.push({
              syncRunId: opts.syncRunId,
              timestamp: now,
              shopifyProductId: c.shopifyProductId,
              sku: c.sku,
              action: "update",
              field: "images",
              oldValue: `pos-1 non conforme: ${plan.currentUrl.split("?")[0]} — ${plan.currentReason}`.slice(0, 255),
              newValue: `pos-1 remplacé par image #${plan.proposedImageId} (était pos ${plan.proposedPosition}) — ${plan.proposedReason}`.slice(0, 255),
            });
          } else {
            // Shopify never confirmed the reorder — leave UNSTAMPED so the next run retries.
            result.errors++;
            log("swap not verified by Shopify — will retry next run", { sku: c.sku, product_id: c.shopifyProductId, image_id: plan.proposedImageId });
          }
        } catch (err) {
          result.errors++;
          log("swap failed (non-fatal) — will retry next run", { sku: c.sku, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "no_alternative":
        // Whole set scanned, nothing clean — genuinely nothing better to offer. The product
        // follows the normal flow untouched; the case is logged for visibility (spec B3).
        result.checked++;
        result.nonCompliant++;
        result.noAlternative++;
        await markResolved(c.shopifyProductId);
        log("non-compliant, no clean alternative — left as is", { sku: c.sku, product_id: c.shopifyProductId, reason: plan.currentReason, scanned: plan.scanned });
        break;

      case "deferred":
        // Budget ran out before the whole set was scanned — a clean image may still exist
        // further down. Leave UNSTAMPED so a future run finishes the scan.
        result.deferred++;
        log("scan truncated by budget — deferring to next run", { sku: c.sku, product_id: c.shopifyProductId });
        break;

      default:
        result.errors++;
        log("audit error (non-fatal) — will retry next run", { sku: c.sku, product_id: c.shopifyProductId, error: plan.error });
        break;
    }
  }

  // Persist audit rows. Non-fatal — losing an audit row is harmless (the decision itself
  // already persisted, either to the review queue or to Shopify).
  if (logEntries.length > 0) {
    try {
      await addSyncLogsBatch(logEntries);
    } catch (err) {
      log("addSyncLogsBatch failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  log("done", { ...result });
  return result;
}
