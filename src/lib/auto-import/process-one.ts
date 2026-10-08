/**
 * Process ONE candidate group end to end for the automatic import.
 *
 *   queue (existing pipeline: image curation, pos-1 guard, variant photos)
 *   → generate copy
 *   → layer 1 rules → gallery check → judge           (nothing exists on Shopify yet)
 *   → create as DRAFT (existing pipeline: pre-publish gates, collections, post-create gates)
 *   → layer 3a: what Shopify stored
 *   → pilot: stop here (draft, tagged for the owner)  |  live: activate
 *   → layer 3b: the public page
 *
 * Any failed layer parks the job as `needs_review` with the reasons; nothing half-published is left
 * visible: a failure after creation unpublishes + tags the product. All LLM calls are charged to the
 * dedicated `import` pool, never the shared `batch` pool.
 */
import { queueForImport, generateContent, importToShopify } from "@/lib/import-pipeline";
import { updateImportJob, getProduct } from "@/lib/database";
import {
  fetchShopifyProductSummary,
  publishShopifyProduct,
  unpublishShopifyProduct,
  updateShopifyProduct,
} from "@/lib/shopify-client";
import { EXCLUDE_TAG } from "@/lib/stale-catalog";
import { withBudgetPool } from "@/lib/llm-budget";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import {
  checkContentStructure,
  checkGallery,
  judgeContent,
  checkShopifySummary,
  checkStorefrontHtml,
} from "./verify";
import type { Candidate, AutoImportMode } from "./policy";

export type ProcessOutcome = "live" | "pilot_draft" | "needs_review" | "skipped" | "error";

export interface ProcessResult {
  outcome: ProcessOutcome;
  groupKey: string;
  shopifyId?: string;
  handle?: string;
  /** Which layer stopped it, when it did. */
  layer?: string;
  reasons: string[];
}

export const PILOT_TAG = "auto-import-pilot";
export const REVIEW_TAG = "needs-review";

async function park(jobId: string, layer: string, reasons: string[]): Promise<void> {
  await updateImportJob(jobId, { status: "needs_review", error: `auto_${layer}_failed:${reasons.join(";")}`.slice(0, 900) });
}

/** A product that failed after creation: take it off the storefront and tag it for a human. */
async function quarantine(shopifyId: string, tags: string[], jobId: string, layer: string, reasons: string[]): Promise<void> {
  try {
    await unpublishShopifyProduct(shopifyId, { deactivate: true, tags: [...new Set([...tags, EXCLUDE_TAG, REVIEW_TAG])] });
  } catch (err) {
    console.error(`[auto-import] quarantine failed for ${shopifyId} (needs manual unpublish):`, err);
  }
  await park(jobId, layer, reasons);
}

async function fetchStorefront(handle: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`${STOREFRONT_BASE_URL}/products/${handle}`, {
        headers: { "user-agent": "ameublo-auto-import-check/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return await res.text();
      last = `http_${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : "fetch_failed";
    }
  }
  throw new Error(`storefront_unreachable:${last}`);
}

export async function processCandidate(c: Candidate, mode: Exclude<AutoImportMode, "off" | "dry">): Promise<ProcessResult> {
  return withBudgetPool("import", async () => {
    const base = { groupKey: c.groupKey };
    const { jobs } = await queueForImport(c.skus);
    const job = jobs[0];
    if (!job) return { ...base, outcome: "skipped", reasons: ["no_job_created"] };

    try {
      const generated = await generateContent(job.id);
      const content = generated.content;
      if (!content) {
        await park(job.id, "generate", ["no_content"]);
        return { ...base, outcome: "needs_review", layer: "generate", reasons: ["no_content"] };
      }

      const l1 = checkContentStructure(job.product, content);
      if (!l1.ok) {
        await park(job.id, "layer1", l1.reasons);
        return { ...base, outcome: "needs_review", layer: "layer1", reasons: l1.reasons };
      }
      const gallery = await checkGallery(job.product.images);
      if (!gallery.ok) {
        await park(job.id, "gallery", gallery.reasons);
        return { ...base, outcome: "needs_review", layer: "gallery", reasons: gallery.reasons };
      }
      const judge = await judgeContent(job.product, content);
      if (!judge.ok) {
        await park(job.id, "judge", judge.reasons);
        return { ...base, outcome: "needs_review", layer: "judge", reasons: judge.reasons };
      }

      const pushed = await importToShopify(job.id, undefined, { status: "draft" });
      if (pushed.status !== "done" || !pushed.shopifyId) {
        // importToShopify already parked it (pre/post gate) or it was a duplicate.
        return { ...base, outcome: "needs_review", layer: "pipeline_gates", reasons: [pushed.status, pushed.error ?? ""].filter(Boolean) };
      }
      const shopifyId = pushed.shopifyId;

      const summary = await fetchShopifyProductSummary(shopifyId);
      const l3 = checkShopifySummary(summary, job.product);
      if (!l3.ok) {
        await quarantine(shopifyId, summary.tags, job.id, "layer3_admin", l3.reasons);
        return { ...base, outcome: "needs_review", layer: "layer3_admin", shopifyId, reasons: l3.reasons };
      }

      if (mode === "pilot") {
        await updateShopifyProduct(shopifyId, { tags: [...new Set([...summary.tags, PILOT_TAG])] });
        return { ...base, outcome: "pilot_draft", shopifyId, handle: summary.handle, reasons: [] };
      }

      await publishShopifyProduct(shopifyId, { activate: true });
      const handle = summary.handle || (await getProduct(c.skus[0]))?.shopify_handle || "";
      let html: string;
      try {
        html = await fetchStorefront(handle);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "storefront_unreachable";
        await quarantine(shopifyId, summary.tags, job.id, "layer3_storefront", [reason]);
        return { ...base, outcome: "needs_review", layer: "layer3_storefront", shopifyId, reasons: [reason] };
      }
      const sf = checkStorefrontHtml(html);
      if (!sf.ok) {
        await quarantine(shopifyId, summary.tags, job.id, "layer3_storefront", sf.reasons);
        return { ...base, outcome: "needs_review", layer: "layer3_storefront", shopifyId, reasons: sf.reasons };
      }

      // Same follow-up an active import gets: the social draft for the new product (best-effort).
      const primarySku = job.product.variants[0]?.sku;
      if (primarySku) {
        import("@/jobs/job4-social")
          .then(({ triggerNewProduct }) => triggerNewProduct(primarySku).catch((e) => console.error(`[auto-import] social draft failed for ${primarySku}:`, e)))
          .catch(() => {});
      }
      return { ...base, outcome: "live", shopifyId, handle, reasons: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateImportJob(job.id, { status: "error", error: msg.slice(0, 900) }).catch(() => {});
      return { ...base, outcome: "error", reasons: [msg.slice(0, 300)] };
    }
  });
}
