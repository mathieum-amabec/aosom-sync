import { fetchAosomCatalog } from "./csv-fetcher";
import { mergeVariants, buildSkuIndex, selectProductImages } from "./variant-merger";
import { generateProductContent, backfillSeoFields, type GeneratedContent } from "./content-generator";
import { createShopifyProduct, addProductToCollection } from "./shopify-client";
import { findCollectionsForProduct, getProduct } from "./database";
import {
  upsertImportJob,
  getImportJobs as dbGetImportJobs,
  getImportJob as dbGetImportJob,
  updateImportJob,
} from "./database";
import type { AosomMergedProduct } from "@/types/aosom";

export type ImportStatus =
  | "pending"
  | "generating"
  | "reviewing"
  | "importing"
  | "done"
  | "error"
  | "already_imported";

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

function rowToJob(row: Record<string, unknown>): ImportJob {
  return {
    id: row.id as string,
    groupKey: row.group_key as string,
    product: JSON.parse(row.product_data as string),
    status: row.status as ImportStatus,
    content: row.content ? JSON.parse(row.content as string) : null,
    shopifyId: (row.shopify_id as string) || null,
    error: (row.error as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Queue products for import by their SKUs.
 */
export async function queueForImport(skus: string[]): Promise<ImportJob[]> {
  const catalog = await fetchAosomCatalog();
  const matched = catalog.filter((p) => skus.includes(p.sku));
  if (matched.length === 0) throw new Error("No matching products found");

  const merged = mergeVariants(matched);
  const now = new Date().toISOString();
  const jobs: ImportJob[] = [];

  for (const rawProduct of merged) {
    // Curate images for the customer-facing product (Étape 1): drop sub-800px
    // images with a detectable size, promote a lifestyle shot to position 1,
    // cap at 8. Done here (import path only) so the daily sync/diff never
    // re-images products that are already live.
    const product = { ...rawProduct, images: selectProductImages(rawProduct.images) };

    // Idempotency: skip any product whose SKU already maps to a Shopify product.
    // Re-importing would create a duplicate (createShopifyProduct always POSTs),
    // and the new product would not carry the original's manual tags/metafields.
    let existingShopifyId: string | null = null;
    for (const v of product.variants) {
      const existing = await getProduct(v.sku);
      if (existing?.shopify_product_id) {
        existingShopifyId = existing.shopify_product_id;
        break;
      }
    }
    if (existingShopifyId) {
      console.log(`[IMPORT] Skipping ${product.groupKey} — already_in_shopify (${existingShopifyId})`);
      continue;
    }

    const id = crypto.randomUUID();
    await upsertImportJob({
      id,
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

  return jobs;
}

/**
 * Generate content for a queued import job.
 */
export async function generateContent(jobId: string): Promise<ImportJob> {
  const row = await dbGetImportJob(jobId);
  if (!row) throw new Error(`Job ${jobId} not found`);

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

  await updateImportJob(jobId, { status: "importing" });

  try {
    const shopifyId = await createShopifyProduct(product, content);
    await updateImportJob(jobId, { status: "done", shopify_id: shopifyId });

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

    // Fire-and-forget social draft for the new product. Re-enabled now that the
    // image infra is in place: triggerNewProduct calls pickRandomImages() to capture
    // the Aosom product photos into image_urls, and the publisher falls back to
    // products.image1 (JOIN) when needed — so product posts always carry an image.
    const primarySku = product.variants[0]?.sku;
    if (primarySku) {
      import("@/jobs/job4-social").then(({ triggerNewProduct }) => {
        triggerNewProduct(primarySku).catch((err) =>
          console.error(`[IMPORT] Social draft failed for ${primarySku}: ${err}`)
        );
      }).catch(() => {});
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

export async function getImportJobById(jobId: string): Promise<ImportJob | null> {
  const row = await dbGetImportJob(jobId);
  return row ? rowToJob(row) : null;
}
