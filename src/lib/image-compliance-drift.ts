/**
 * Detects a Shopify-side-only change to an already-"checked" product's pos-1 image.
 *
 * image_checked_at (image-compliance.ts) only resets to NULL when products.image1 (the
 * Aosom feed URL) changes — refreshProducts's UPSERT is the sole writer of that reset. It
 * never notices a change that happens purely on the Shopify side: a re-ingest that mints a
 * new image id for the same photo, a manual reorder in Shopify Admin, or a genuinely
 * different photo landing at position 1 through some other path. A product can therefore
 * sit "checked" — and so permanently invisible to the daily classification pass — while its
 * live pos-1 has silently drifted into non-compliance.
 *
 * Root-cause regression, 2026-09-17: 13 of 32 non-compliant catalogue-wide pos-1 images were
 * in exactly this state (image_checked_at set, but the live pos-1 stem had zero
 * image_classifications coverage — the photo Shopify now shows was never judged).
 *
 * This pass is Shopify-API-only cost (one GET per product, ~2 req/sec), NEVER a Claude call —
 * it must not compete with the classification budget (batch OR maintenance) at all. It just
 * refetches the live gallery for a batch of already-checked products (oldest-checked first)
 * and resets image_checked_at (+ image_gallery_signature) to NULL wherever the live pos-1
 * stem no longer matches what was verified — dropping the product back into the ordinary
 * getImageComplianceCandidates() queue, where the next classification pass picks it up.
 */
import { fetchProductImages } from "./shopify-client";
import { imageUrlStem } from "./image-compliance-audit";
import { getCheckedProductsForDriftScan, resetImageChecked } from "./database";
import { env } from "./config";

// Bounded only by the Shopify REST rate limit (~2 req/sec), not by any LLM budget — this is
// a plain GET per product. 500/day scans the full checked set (~1,559 products, per the
// 2026-09-17 audit) in about 3-4 days, at roughly 4-5 minutes of wall clock per run.
export const DEFAULT_DRIFT_SCAN_LIMIT = 500;

export interface GalleryDriftResult {
  /** Already-checked products whose live gallery was refetched this run. */
  scanned: number;
  /** Of those, how many had a pos-1 stem mismatch and were reset to NULL. */
  drifted: number;
  /** Shopify fetch failures (non-fatal, left unresolved for next run). */
  errors: number;
}

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "image-compliance-drift", msg, ...extra }));
}

/**
 * Run one drift-detection pass. Returns counts; never throws (best-effort, same contract as
 * runImageCompliance).
 */
export async function checkGalleryDrift(opts: { limit?: number } = {}): Promise<GalleryDriftResult> {
  const result: GalleryDriftResult = { scanned: 0, drifted: 0, errors: 0 };
  const limit = opts.limit ?? DEFAULT_DRIFT_SCAN_LIMIT;
  if (limit <= 0) return result;

  if (!env.hasShopifyToken) {
    log("no Shopify token — skipping drift scan");
    return result;
  }

  let candidates;
  try {
    candidates = await getCheckedProductsForDriftScan(limit);
  } catch (err) {
    log("candidate query failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    return result;
  }
  if (candidates.length === 0) {
    log("no checked products to scan");
    return result;
  }

  const drifted: string[] = [];
  for (const c of candidates) {
    result.scanned++;
    let gallery;
    try {
      gallery = await fetchProductImages(c.shopifyProductId);
    } catch (err) {
      result.errors++;
      log("gallery fetch failed (non-fatal) — will retry next run", {
        product_id: c.shopifyProductId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const livePos1 = gallery[0]?.src ?? "";
    const liveStem = livePos1 ? imageUrlStem(livePos1) : "";
    const storedStem = c.signature ?? "";
    if (liveStem !== storedStem) {
      drifted.push(c.shopifyProductId);
      log("pos-1 drift detected — resetting for re-check", {
        sku: c.sku,
        product_id: c.shopifyProductId,
        stored_stem: storedStem || "(none)",
        live_stem: liveStem || "(no images)",
      });
    }
  }

  if (drifted.length > 0) {
    try {
      await resetImageChecked(drifted);
      result.drifted = drifted.length;
    } catch (err) {
      log("resetImageChecked failed (non-fatal) — drifted products stay checked until next run", {
        count: drifted.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log(`finished: ${result.scanned} scanned, ${result.drifted} drifted, ${result.errors} errors`);
  return result;
}
