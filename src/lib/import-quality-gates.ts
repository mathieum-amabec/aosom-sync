/**
 * Shared quality gates for the import pipeline — one function, two call sites
 * (pre-publish, before createShopifyProduct; post-publish, against what Shopify
 * actually serves), so the two can never disagree about what "clean" means.
 * Also the function the future bulk-select for "reviewing" jobs will call.
 *
 * Three checks, all reusing existing mechanisms rather than inventing new ones:
 *  1. Primary image clean — enforceCleanPrimaryImage (image-compliance-audit.ts).
 *  2. Description reads as French — detectDescriptionLanguage (catalog-guard.ts),
 *     the FR/EN word-frequency detector already validated 2026-09-11 against all
 *     1382 active products (703 FR, 679 EN, zero MIXED, zero empty). No new
 *     heuristic needed or built here — this already existed and is exactly what
 *     was asked to be reused.
 *  3. No supplier brand leak — forbiddenBrandsIn (catalog-guard.ts), the same
 *     canonical brand list stripSupplierBrands strips at generation time.
 *
 * Cost: 0 additional LLM calls in the common case. enforceCleanPrimaryImage caches
 * verdicts by photo "stem" (image_classifications table) — these images were
 * already classified once at queue time (queueForImport), so a re-check here is a
 * cache hit. detectDescriptionLanguage and forbiddenBrandsIn are pure regex —
 * no LLM, no network.
 */
import { enforceCleanPrimaryImage } from "./image-compliance-audit";
import { detectDescriptionLanguage, forbiddenBrandsIn } from "./catalog-guard";

export type QualityGateFailure = "image_not_clean" | "not_french" | "brand_leak";

export interface QualityGateResult {
  passed: boolean;
  failures: QualityGateFailure[];
}

/**
 * Run the three quality gates against a product's images and FR copy.
 *
 * @param images     candidate images, pos-1 first (pre-publish: the curated array
 *                   about to be sent to Shopify; post-publish: what Shopify actually
 *                   has on the product right now).
 * @param content    the title/description actually being shipped (pre-publish:
 *                   the generated content; post-publish: what Shopify serves).
 */
export async function runQualityGates(
  images: string[],
  content: { titleFr: string; descriptionFr: string },
): Promise<QualityGateResult> {
  const failures: QualityGateFailure[] = [];

  // 1. Primary image. "no_alternative" is the only outcome that means pos-1 carries
  // an overlay with nothing clean to promote instead — "clean"/"reordered" pass, and
  // "skipped" (no verdict obtained) passes too: no evidence is not evidence of a
  // problem, same convention enforceCleanPrimaryImage's other callers already use.
  const guard = await enforceCleanPrimaryImage(images);
  if (guard.outcome === "no_alternative") failures.push("image_not_clean");

  // 2. French. Only "FR" passes — "EN", "MIXED", and "empty" are all failures. The
  // 1382-product validation this detector was built on found zero MIXED/empty
  // among real (clean) French descriptions, so being strict here (FR-only) does
  // not risk flagging genuine copy.
  if (detectDescriptionLanguage(content.descriptionFr).lang !== "FR") {
    failures.push("not_french");
  }

  // 3. Brand leak — checked on title + description together.
  if (forbiddenBrandsIn(`${content.titleFr} ${content.descriptionFr}`).length > 0) {
    failures.push("brand_leak");
  }

  return { passed: failures.length === 0, failures };
}

// The batch-level circuit breaker (shouldTripCircuitBreaker) lives in
// import-batch-guard.ts, NOT here — this module transitively imports
// database.ts/shopify-client.ts/vision-classifier.ts (server-only), and the
// circuit breaker is called from the "use client" import/page.tsx. Keeping it
// out of this file's module graph is what keeps that import buildable.
