import { fetchAosomCatalog } from "./csv-fetcher";
import { mergeVariants, buildSkuIndex } from "./variant-merger";
import { generateProductContent, type GeneratedContent } from "./content-generator";
import { createShopifyProduct, addProductToCollection } from "./shopify-client";
import { findCollectionsForProduct } from "./database";
import {
  upsertImportJob,
  getImportJobs as dbGetImportJobs,
  getImportJob as dbGetImportJob,
  updateImportJob,
} from "./database";
import type { AosomMergedProduct } from "@/types/aosom";

export type ImportStatus = "pending" | "generating" | "reviewing" | "importing" | "done" | "error";

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

  for (const product of merged) {
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
  if (!row.content) throw new Error("Content not generated yet");

  const product: AosomMergedProduct = JSON.parse(row.product_data as string);
  let content: GeneratedContent = JSON.parse(row.content as string);
  if (contentOverrides) content = { ...content, ...contentOverrides };

  await updateImportJob(jobId, { status: "importing" });

  try {
    const shopifyId = await createShopifyProduct(product, content);
    await updateImportJob(jobId, { status: "done", shopify_id: shopifyId });

    // Dual collection assignment: every product gets a main + a sub (when both mappings exist).
    // Non-blocking — failures are logged but don't fail the import.
    const { main, sub } = await findCollectionsForProduct(product.productType);
    const planned: Array<{ role: "main" | "sub"; title: string; id: string }> = [];
    if (main) planned.push({ role: "main", title: main.shopifyCollectionTitle, id: main.shopifyCollectionId });
    if (sub) planned.push({ role: "sub", title: sub.shopifyCollectionTitle, id: sub.shopifyCollectionId });

    if (planned.length === 0) {
      console.log(`[IMPORT] No collection mapping for category: ${product.productType}`);
    } else {
      const succeeded: Array<"main" | "sub"> = [];
      const failed: Array<{ role: "main" | "sub"; title: string; error: string }> = [];
      for (const a of planned) {
        try {
          await addProductToCollection(shopifyId, a.id);
          succeeded.push(a.role);
          console.log(
            `[IMPORT] Added to [${a.role}] "${a.title}" (${product.productType}) — SKU ${product.variants[0]?.sku ?? "?"}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failed.push({ role: a.role, title: a.title, error: msg });
          console.error(`[IMPORT] Collection assignment failed for ${shopifyId} [${a.role}] ${a.title}: ${msg}`);
        }
      }
      // Warn if the product is NOT in both a main AND a sub after attempting.
      // This catches both "missing mapping" and "POST failed" cases.
      const hasMain = succeeded.includes("main");
      const hasSub = succeeded.includes("sub");
      if (!hasMain || !hasSub) {
        const missing = !hasMain && !hasSub ? "main AND sub" : !hasMain ? "main" : "sub";
        const reason = planned.length < 2 ? "missing mapping" : "POST failed";
        console.warn(
          `[IMPORT] ⚠ Product ${shopifyId} (${product.productType}) not dual-assigned — missing ${missing} (${reason})`,
        );
      }
    }

    // Trigger social draft for new product (async, non-blocking)
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
