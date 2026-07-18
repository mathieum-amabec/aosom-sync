/**
 * Automatic pos-1 image compliance.
 *
 * After a sync writes products, this pass picks the newest never-checked products that are
 * live on Shopify, classifies their pos-1 (featured) image, and — when it carries a
 * marketing text overlay — swaps in the first clean alternative from the gallery (the same
 * PUT-position:1 mechanism as the 141 manual swaps). Every swap is recorded in sync_logs.
 *
 * Cost guard: at most `maxClassifications` Claude vision calls per run (default 20), spread
 * across pos-1 checks AND the gallery scan for a replacement. Candidates are ordered
 * newest-import-first (products.created_at DESC), so fresh imports are prioritized.
 *
 * Fully non-fatal: this is a best-effort enhancement layered on top of the sync — any
 * failure is logged and swallowed so it can never fail an otherwise-successful sync.
 */
import { classifyProductImage } from "./vision-classifier";
import { fetchProductImages, moveImageToFirstPosition, type ShopifyProductImage } from "./shopify-client";
import {
  getImageComplianceCandidates,
  markImageChecked,
  addSyncLogsBatch,
} from "./database";
import type { SyncLogEntry } from "@/types/sync";

export const DEFAULT_MAX_CLASSIFICATIONS = 20;

export interface ImageComplianceResult {
  /** Products whose pos-1 image was classified. */
  checked: number;
  /** pos-1 already compliant (no marketing overlay). */
  compliant: number;
  /** pos-1 non-compliant (marketing overlay detected). */
  nonCompliant: number;
  /** Non-compliant products where pos-1 was swapped for a clean gallery image. */
  swapped: number;
  /** Non-compliant products with no clean alternative in the gallery. */
  noAlternative: number;
  /** Total Claude vision calls consumed (capped at maxClassifications). */
  classifications: number;
  /** Per-product / per-image errors (non-fatal). */
  errors: number;
}

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "image-compliance", msg, ...extra }));
}

const emptyResult = (): ImageComplianceResult => ({
  checked: 0, compliant: 0, nonCompliant: 0, swapped: 0, noAlternative: 0, classifications: 0, errors: 0,
});

/**
 * Run one pos-1 compliance pass. Returns counts; never throws (best-effort).
 */
export async function runImageCompliance(opts: {
  syncRunId: string;
  maxClassifications?: number;
}): Promise<ImageComplianceResult> {
  const result = emptyResult();
  const maxClassifications = opts.maxClassifications ?? DEFAULT_MAX_CLASSIFICATIONS;
  if (maxClassifications <= 0) return result;

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
  log(`starting: ${candidates.length} candidate(s), budget ${maxClassifications}`);

  let budgetLeft = maxClassifications;
  const logEntries: Omit<SyncLogEntry, "id">[] = [];
  const now = new Date().toISOString();
  const checkedIds: string[] = [];

  for (const c of candidates) {
    if (budgetLeft <= 0) break;
    try {
      const images = await fetchProductImages(c.shopifyProductId);
      const pos1 = images.find((im) => im.position === 1) ?? images[0];
      if (!pos1 || !pos1.src) {
        // No image to classify — mark checked so we don't retry it every run.
        checkedIds.push(c.shopifyProductId);
        continue;
      }

      // Classify pos-1 (1 call).
      budgetLeft--;
      result.classifications++;
      const verdict = await classifyProductImage(pos1.src);
      result.checked++;
      checkedIds.push(c.shopifyProductId); // classified → mark checked (won't recheck until image1 changes)

      if (verdict.compliant) {
        result.compliant++;
        continue;
      }
      result.nonCompliant++;

      // Look for a clean alternative among the OTHER gallery images, spending remaining
      // budget. First compliant image wins.
      const alternatives = images.filter((im) => im.id !== pos1.id && im.src);
      let swapTo: ShopifyProductImage | null = null;
      let altReason = "";
      for (const alt of alternatives) {
        if (budgetLeft <= 0) break;
        budgetLeft--;
        result.classifications++;
        let altVerdict;
        try {
          altVerdict = await classifyProductImage(alt.src);
        } catch (altErr) {
          result.errors++;
          log("alternative classify error", { sku: c.sku, product_id: c.shopifyProductId, image_id: alt.id, error: altErr instanceof Error ? altErr.message : String(altErr) });
          continue; // a single bad alt image must not abort the search
        }
        if (altVerdict.compliant) {
          swapTo = alt;
          altReason = altVerdict.reason;
          break;
        }
      }

      if (!swapTo) {
        result.noAlternative++;
        log("non-compliant, no clean alternative", { sku: c.sku, product_id: c.shopifyProductId, reason: verdict.reason });
        continue;
      }

      const verified = await moveImageToFirstPosition(c.shopifyProductId, swapTo.id);
      if (verified) {
        result.swapped++;
        log("swapped pos-1", { sku: c.sku, product_id: c.shopifyProductId, new_image_id: swapTo.id, was_position: swapTo.position });
        logEntries.push({
          syncRunId: opts.syncRunId,
          timestamp: now,
          shopifyProductId: c.shopifyProductId,
          sku: c.sku,
          action: "update",
          field: "images",
          oldValue: `pos-1 non conforme: ${pos1.src.split("?")[0]} — ${verdict.reason}`.slice(0, 255),
          newValue: `pos-1 remplacé par image #${swapTo.id} (était pos ${swapTo.position}) — ${altReason}`.slice(0, 255),
        });
      } else {
        result.errors++;
        log("swap not verified by Shopify", { sku: c.sku, product_id: c.shopifyProductId, image_id: swapTo.id });
      }
    } catch (err) {
      result.errors++;
      log("candidate error (non-fatal)", { sku: c.sku, product_id: c.shopifyProductId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Stamp checked products + persist swap logs. Both non-fatal — bookkeeping must never
  // fail the sync, and a partial-budget run still records what it did.
  if (checkedIds.length > 0) {
    try {
      await markImageChecked(checkedIds);
    } catch (err) {
      log("markImageChecked failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    }
  }
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
