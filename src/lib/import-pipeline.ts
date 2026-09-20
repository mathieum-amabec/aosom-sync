import { fetchAosomCatalog } from "./csv-fetcher";
import { mergeVariants, selectProductImagesAsync } from "./variant-merger";
import { enforceCleanPrimaryImage } from "./image-compliance-audit";
import { generateProductContent, backfillSeoFields, type GeneratedContent } from "./content-generator";
import { runQualityGates } from "./import-quality-gates";
import {
  createShopifyProduct,
  addProductToCollection,
  unpublishShopifyProduct,
  fetchShopifyProductContent,
} from "./shopify-client";
import { EXCLUDE_TAG } from "./stale-catalog";
import { findCollectionsForProduct, getProduct, linkProductToShopify } from "./database";
import {
  upsertImportJob,
  getImportJobs as dbGetImportJobs,
  getImportJob as dbGetImportJob,
  updateImportJob,
} from "./database";
import type { AosomMergedProduct, AosomProduct } from "@/types/aosom";

export type ImportStatus =
  | "pending"
  | "generating"
  | "reviewing"
  | "importing"
  | "done"
  | "error"
  | "already_imported"
  // A quality gate (clean image / French copy / no supplier-brand leak) failed —
  // either before the Shopify push (no shopifyId set) or after, against what
  // Shopify actually serves (shopifyId set, but auto-unpublished — see
  // import-quality-gates.ts and importToShopify's post-publish safety net).
  | "needs_review";

export interface ImportJob {
  id: string;
  groupKey: string;
  product: AosomMergedProduct;
  status: ImportStatus;
  content: GeneratedContent | null;
  shopifyId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseContent(raw: unknown): GeneratedContent | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as GeneratedContent;
  } catch {
    return null;
  }
}

function rowToJob(row: Record<string, unknown>): ImportJob {
  return {
    id: row.id as string,
    groupKey: row.group_key as string,
    product: JSON.parse(row.product_data as string),
    status: row.status as ImportStatus,
    // Tolerate an unparseable content column instead of throwing: a corrupt payload must
    // degrade to "no content yet" (which callers already handle by regenerating), not blow
    // up every read of the job — including the regeneration that would have repaired it.
    content: parseContent(row.content),
    shopifyId: (row.shopify_id as string) || null,
    error: (row.error as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Why a requested SKU produced no import job. */
export type SkippedImportReason = "already_imported" | "not_in_feed";

export interface SkippedImportSku {
  sku: string;
  reason: SkippedImportReason;
}

export interface QueueForImportResult {
  jobs: ImportJob[];
  /** Requested SKUs that did NOT get a job, with why — surfaced to the caller instead
   * of silently vanishing (see the 2026-09-19 investigation: a batch that mixed an
   * already-imported SKU with a never-imported sibling used to drop BOTH with no
   * feedback at all, and the API still returned 200). */
  skipped: SkippedImportSku[];
}

/**
 * Queue products for import by their SKUs.
 */
export async function queueForImport(skus: string[]): Promise<QueueForImportResult> {
  const catalog = await fetchAosomCatalog();
  const catalogSkus = new Set(catalog.map((p) => p.sku));
  const skipped: SkippedImportSku[] = [];

  // A SKU the caller asked for but that no longer exists in the live Aosom feed
  // (discontinued by the supplier since it was catalogued). Used to vanish from
  // `matched` below with zero trace — report it instead.
  for (const sku of skus) {
    if (!catalogSkus.has(sku)) skipped.push({ sku, reason: "not_in_feed" });
  }

  const matched = catalog.filter((p) => skus.includes(p.sku));

  // Idempotency, checked PER REQUESTED SKU, before merging — not per merged group,
  // after. mergeVariants() below combines every matched SKU that shares a group into
  // ONE AosomMergedProduct; checking idempotency only after that merge (the previous
  // behaviour) meant one already-imported SKU submitted alongside a never-imported
  // sibling of the same product took the WHOLE merged group down with it — the
  // never-imported sibling got no job, no error, nothing (reproduced live 2026-09-19:
  // 501-004PK + 501-004BK submitted together → 0 jobs, though 501-004PK alone queued
  // fine). Filtering here, before mergeVariants ever sees the already-imported SKU,
  // means it's dropped on its own — correctly, silently — without touching its
  // siblings.
  const toMerge: AosomProduct[] = [];
  for (const p of matched) {
    const existing = await getProduct(p.sku);
    if (existing?.shopify_product_id) {
      skipped.push({ sku: p.sku, reason: "already_imported" });
    } else {
      toMerge.push(p);
    }
  }

  if (toMerge.length === 0) return { jobs: [], skipped };

  const merged = mergeVariants(toMerge);
  const now = new Date().toISOString();
  const jobs: ImportJob[] = [];

  for (const rawProduct of merged) {
    // Curate images for the customer-facing product (Étape 1+2): drop sub-800px
    // images with a detectable size, then order lifestyle shots first (URL regex
    // OR white-background analysis), CSV order next, white studio shots last; cap
    // at 8. Async because it downloads/analyses images — affordable here (import
    // path only, per curated product) but never run at daily-sync scale.
    const curated = await selectProductImagesAsync(rawProduct.images);

    // Guard the pos-1 image BEFORE the product is ever written (spec C). Curation above orders
    // lifestyle shots first but is blind to text burned onto the photo — which is exactly what
    // Aosom's dimension infographics are, and how all 312 of the queue's products got a dirty
    // primary image in the first place. One vision call per import (charged to the `batch`
    // pool like the rest of the import path — `maintenance` is scripts-only by design), and
    // the correction becomes free because nothing is live yet.
    const guard = await enforceCleanPrimaryImage(curated);
    if (guard.outcome === "reordered") {
      console.log(`[IMPORT] pos-1 overlay évité pour ${rawProduct.groupKey} — image #${guard.promotedFrom} promue: ${guard.reason}`);
    } else if (guard.outcome === "no_alternative") {
      // Rare, and deliberately NOT a blocker: the product imports as-is and the daily guard
      // will keep an eye on it, the same as the 6 catalogue products in this situation.
      console.warn(`[IMPORT] ${rawProduct.groupKey}: pos-1 porte du texte et AUCUNE alternative propre — importé tel quel: ${guard.reason}`);
    } else if (guard.outcome === "skipped") {
      console.warn(`[IMPORT] ${rawProduct.groupKey}: vérification pos-1 impossible (importé tel quel): ${guard.reason ?? "aucun verdict"}`);
    }

    const product = { ...rawProduct, images: guard.images };

    // Defensive re-check, not the primary guard anymore (that's the per-SKU filter
    // above, before merge). Catches only a race: the product got imported by a
    // concurrent request in the window between the filter above and here. Every
    // variant still trapped in this merged group is reported skipped — a race is
    // rare enough that "silently dropped" would be a worse failure mode than
    // "briefly slower to notice", now that we have the vocabulary to report it.
    let existingShopifyId: string | null = null;
    for (const v of product.variants) {
      const existing = await getProduct(v.sku);
      if (existing?.shopify_product_id) {
        existingShopifyId = existing.shopify_product_id;
        break;
      }
    }
    if (existingShopifyId) {
      console.log(`[IMPORT] Skipping ${product.groupKey} — already_in_shopify (${existingShopifyId}) [race, post-merge]`);
      for (const v of product.variants) skipped.push({ sku: v.sku, reason: "already_imported" });
      continue;
    }

    // Use the id the upsert actually persisted: ON CONFLICT(group_key) keeps a
    // pre-existing row's id, so a stale row from an earlier failed attempt would
    // otherwise leave `jobs` pointing at a non-existent id ("Job not found").
    const id = await upsertImportJob({
      id: crypto.randomUUID(),
      groupKey: product.groupKey,
      productData: JSON.stringify(product),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    jobs.push({
      id,
      groupKey: product.groupKey,
      product,
      status: "pending",
      content: null,
      shopifyId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { jobs, skipped };
}

/**
 * Generate content for a queued import job.
 */
export async function generateContent(jobId: string, opts?: { force?: boolean }): Promise<ImportJob> {
  const row = await dbGetImportJob(jobId);
  if (!row) throw new Error(`Job ${jobId} not found`);

  // Reuse guard. import_jobs.group_key is UNIQUE and equals the Aosom PSIN group, and
  // `mergeVariants` already folds every colour/size of a group into ONE merged product
  // whose variant list is part of the prompt — so a group's listing is generated exactly
  // once and already covers its variants. What can still burn a duplicate call is
  // re-generating a job that already holds content: `upsertImportJob` resets a re-queued
  // group to 'pending' WITHOUT clearing `content`, and a retry after a failed Shopify push
  // lands here too. Both used to pay for a fresh generation of near-identical copy.
  // Pass { force: true } to deliberately regenerate (e.g. after a prompt change).
  if (!opts?.force) {
    const cached = parseContent(row.content);
    // Only trust a payload that still satisfies the contract importToShopify relies on;
    // anything unparseable or half-written falls through and is regenerated.
    if (cached && typeof cached.titleFr === "string" && typeof cached.descriptionFr === "string") {
      console.log(`[import-pipeline] reusing stored content for group ${row.group_key} (no Claude call)`);
      // A job that already shipped to Shopify keeps its status: moving a 'done' row back
      // to 'reviewing' would show an imported product as still awaiting review. Reuse made
      // this call cheap, so it is far likelier to be hit on an already-pushed job than before.
      if (row.shopify_id) return rowToJob(row);
      await updateImportJob(jobId, { status: "reviewing" });
      return { ...rowToJob(row), status: "reviewing", content: cached };
    }
  }

  await updateImportJob(jobId, { status: "generating" });

  try {
    const product: AosomMergedProduct = JSON.parse(row.product_data as string);
    const content = await generateProductContent(product);

    await updateImportJob(jobId, {
      status: "reviewing",
      content: JSON.stringify(content),
    });

    return { ...rowToJob(row), status: "reviewing", content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateImportJob(jobId, { status: "error", error: msg });
    throw err;
  }
}

/**
 * Push a reviewed job to Shopify.
 */
export async function importToShopify(
  jobId: string,
  contentOverrides?: Partial<GeneratedContent>
): Promise<ImportJob> {
  const row = await dbGetImportJob(jobId);
  if (!row) throw new Error(`Job ${jobId} not found`);

  // Idempotency guard: a job that already produced a Shopify product must not be
  // re-imported. createShopifyProduct is an unconditional POST, so re-running would
  // create a duplicate product (new ID), and the duplicate would lack any manually
  // added tags/metafields. Return early instead of creating the duplicate.
  if (row.shopify_id) {
    return { ...rowToJob(row), status: "already_imported" };
  }

  if (!row.content) throw new Error("Content not generated yet");

  const product: AosomMergedProduct = JSON.parse(row.product_data as string);
  let content: GeneratedContent = JSON.parse(row.content as string);
  if (contentOverrides) content = { ...content, ...contentOverrides };
  // Jobs generated before product-naming-v2 have no SEO-native fields; fill safe
  // defaults so a stale job imports with degraded SEO instead of 422-ing.
  content = backfillSeoFields(content, product.brand);

  // Pre-publish quality gate: same three checks the post-publish safety net runs
  // below, but here a failure means the product is never created at all — cheaper
  // to catch than to un-publish, and it can't leave a defective listing live even
  // for the few seconds between create and the post-publish check.
  const preGate = await runQualityGates(product.images, content);
  if (!preGate.passed) {
    console.warn(`[IMPORT] Pre-publish quality gate FAILED for ${row.group_key} (${preGate.failures.join(",")}) — not pushed`);
    await updateImportJob(jobId, {
      status: "needs_review",
      error: `pre_publish_gate_failed:${preGate.failures.join(",")}`,
    });
    return { ...rowToJob(row), status: "needs_review", content };
  }

  await updateImportJob(jobId, { status: "importing" });

  try {
    const { id: shopifyId, handle: shopifyHandle } = await createShopifyProduct(product, content);
    await updateImportJob(jobId, { status: "done", shopify_id: shopifyId });

    // Persist the Shopify mapping (id + storefront handle) onto the catalog rows so the
    // dashboard "In store" badge can deep-link to ameublodirect.ca/products/{handle}.
    // Best-effort: a failure here must not fail the (already successful) import.
    try {
      await linkProductToShopify(product.variants.map((v) => v.sku), shopifyId, shopifyHandle || null);
    } catch (linkErr) {
      console.error(`[IMPORT] Failed to persist shopify handle for ${shopifyId}:`, linkErr);
    }

    // Dual collection assignment: every product gets a main + a sub (when both mappings exist).
    // Non-blocking — failures are logged but don't fail the import.
    // Deduplicates when both roles resolve to the same Shopify collection (happens when a
    // level-1 main mapping and a level-2 sub mapping both target the same collection, e.g.
    // "Toys & Games" main + "Toys & Games > Baby & Toddler Toys" sub both → Jouets pour enfants).
    const { main, sub } = await findCollectionsForProduct(product.productType);
    const planned: Array<{ role: "main" | "sub"; title: string; id: string }> = [];
    if (main) planned.push({ role: "main", title: main.shopifyCollectionTitle, id: main.shopifyCollectionId });
    if (sub && (!main || sub.shopifyCollectionId !== main.shopifyCollectionId)) {
      planned.push({ role: "sub", title: sub.shopifyCollectionTitle, id: sub.shopifyCollectionId });
    }

    if (planned.length === 0) {
      console.log(`[IMPORT] No collection mapping for category: ${product.productType}`);
    } else {
      const succeeded: Array<"main" | "sub"> = [];
      for (const a of planned) {
        try {
          await addProductToCollection(shopifyId, a.id);
          succeeded.push(a.role);
          console.log(
            `[IMPORT] Added to [${a.role}] "${a.title}" (${product.productType}) — SKU ${product.variants[0]?.sku ?? "?"}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[IMPORT] Collection assignment failed for ${shopifyId} [${a.role}] ${a.title}: ${msg}`);
        }
      }
      // Warn if the product didn't land in both a resolved main AND a resolved sub.
      // Special case: when main and sub point to the SAME collection, one successful
      // assignment satisfies both roles — no warning.
      const mainResolvedAndDone = main && (succeeded.includes("main") || (sub && main.shopifyCollectionId === sub.shopifyCollectionId && succeeded.includes("sub")));
      const subResolvedAndDone = sub && (succeeded.includes("sub") || (main && main.shopifyCollectionId === sub.shopifyCollectionId && succeeded.includes("main")));
      if (!main || !sub || !mainResolvedAndDone || !subResolvedAndDone) {
        const missingMapping = !main || !sub;
        const missingRole = !main ? "main" : !sub ? "sub" : !mainResolvedAndDone ? "main (POST failed)" : "sub (POST failed)";
        const reason = missingMapping ? "missing mapping" : "POST failed";
        console.warn(
          `[IMPORT] ⚠ Product ${shopifyId} (${product.productType}) not dual-assigned — missing ${missingRole} (${reason})`,
        );
      }
    }

    // Fire-and-forget social draft for the new product. triggerNewProduct posts the
    // product's clean Shopify position-1 lifestyle photo raw, and self-skips when the
    // product isn't lifestyle-verified yet (typical for a brand-new import).
    const primarySku = product.variants[0]?.sku;
    if (primarySku) {
      import("@/jobs/job4-social").then(({ triggerNewProduct }) => {
        triggerNewProduct(primarySku).catch((err) =>
          console.error(`[IMPORT] Social draft failed for ${primarySku}: ${err}`)
        );
      }).catch(() => {});
    }

    // Post-publish quality safety net: re-run the SAME gates against what Shopify
    // actually serves (not what we generated) — catches drift between generation
    // and what got stored, or anything the pre-publish check missed. Best-effort:
    // a failure IN the check itself must not fail the (already successful) import,
    // and must not silently hide that the check didn't run.
    try {
      const served = await fetchShopifyProductContent(shopifyId);
      const postGate = await runQualityGates(served.images, {
        titleFr: served.title,
        descriptionFr: served.bodyHtml,
      });
      if (!postGate.passed) {
        console.warn(
          `[IMPORT] Post-publish quality gate FAILED for ${shopifyId} (${postGate.failures.join(",")}) — unpublishing`,
        );
        await unpublishShopifyProduct(shopifyId, {
          deactivate: true,
          tags: [...served.tags, EXCLUDE_TAG, "needs-review"],
        });
        await updateImportJob(jobId, {
          status: "needs_review",
          error: `post_publish_gate_failed:${postGate.failures.join(",")}`,
        });
        return { ...rowToJob(row), status: "needs_review", shopifyId, content };
      }
    } catch (err) {
      console.error(`[IMPORT] Post-publish quality check errored for ${shopifyId} (product stays published):`, err);
    }

    return { ...rowToJob(row), status: "done", shopifyId, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateImportJob(jobId, { status: "error", error: msg });
    throw err;
  }
}

export async function getImportJobsList(): Promise<ImportJob[]> {
  const rows = await dbGetImportJobs();
  return rows.map(rowToJob);
}
