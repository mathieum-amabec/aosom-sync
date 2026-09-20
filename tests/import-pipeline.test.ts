/**
 * Tests for import-pipeline.ts idempotency guards.
 *
 * 1. importToShopify: job with shopify_id already set → returns "already_imported",
 *    never calls createShopifyProduct (no duplicate).
 * 2. importToShopify: fresh job → calls createShopifyProduct once, status "done".
 * 3. queueForImport: SKU already mapped to a Shopify product → skipped, no job created.
 * 4. queueForImport: SKU not yet in Shopify → job queued.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (declared before importing the module under test) ───
vi.mock("@/lib/csv-fetcher", () => ({
  fetchAosomCatalog: vi.fn(),
}));
vi.mock("@/lib/variant-merger", () => ({
  mergeVariants: vi.fn(),
  buildSkuIndex: vi.fn(),
  selectProductImages: vi.fn((imgs: string[]) => imgs),
  selectProductImagesAsync: vi.fn(async (imgs: string[]) => imgs),
}));
vi.mock("@/lib/content-generator", () => ({
  generateProductContent: vi.fn(),
  backfillSeoFields: vi.fn((c: unknown) => c),
}));
vi.mock("@/lib/shopify-client", () => ({
  createShopifyProduct: vi.fn(),
  addProductToCollection: vi.fn().mockResolvedValue(undefined),
  unpublishShopifyProduct: vi.fn().mockResolvedValue(undefined),
  fetchShopifyProductContent: vi.fn().mockResolvedValue({
    title: "Chaise longue",
    bodyHtml: "<p>fr</p>",
    images: ["https://cdn/a.jpg"],
    tags: [],
  }),
}));
// Default: gates pass. Individual tests override with mockResolvedValueOnce to
// exercise the pre-publish / post-publish failure paths without re-testing the
// gates' own internals (see tests/import-quality-gates.test.ts for that).
vi.mock("@/lib/import-quality-gates", () => ({
  runQualityGates: vi.fn().mockResolvedValue({ passed: true, failures: [] }),
}));
vi.mock("@/lib/stale-catalog", () => ({
  EXCLUDE_TAG: "exclude-stale",
}));
vi.mock("@/lib/database", () => ({
  upsertImportJob: vi.fn().mockResolvedValue(undefined),
  getImportJobs: vi.fn().mockResolvedValue([]),
  getImportJob: vi.fn(),
  updateImportJob: vi.fn().mockResolvedValue(undefined),
  getProduct: vi.fn(),
  findCollectionsForProduct: vi.fn().mockResolvedValue({ main: null, sub: null }),
  linkProductToShopify: vi.fn().mockResolvedValue(undefined),
}));
// Social draft generation is fire-and-forget after a successful import; mock it so the
// dynamic import resolves to a stub instead of loading the real (Anthropic-backed) job.
vi.mock("@/jobs/job4-social", () => ({
  triggerNewProduct: vi.fn().mockResolvedValue({ draftId: 1 }),
}));

import { importToShopify, queueForImport, generateContent } from "@/lib/import-pipeline";
import { generateProductContent } from "@/lib/content-generator";
import { createShopifyProduct, unpublishShopifyProduct, fetchShopifyProductContent } from "@/lib/shopify-client";
import { runQualityGates } from "@/lib/import-quality-gates";
import { getImportJob, getProduct, upsertImportJob, updateImportJob } from "@/lib/database";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { mergeVariants } from "@/lib/variant-merger";
import { triggerNewProduct } from "@/jobs/job4-social";

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    group_key: "G1",
    product_data: JSON.stringify({ groupKey: "G1", productType: "X", images: [], variants: [{ sku: "S1" }] }),
    status: "reviewing",
    content: JSON.stringify({ tags: [] }),
    shopify_id: null,
    error: null,
    created_at: "t0",
    updated_at: "t0",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("importToShopify — duplicate-job guard", () => {
  it("returns 'already_imported' and does NOT create when shopify_id is set", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ status: "done", shopify_id: "999" }));

    const job = await importToShopify("job-1");

    expect(job.status).toBe("already_imported");
    expect(job.shopifyId).toBe("999");
    expect(createShopifyProduct).not.toHaveBeenCalled();
  });

  it("creates the product when the job has no shopify_id yet", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });

    const job = await importToShopify("job-1");

    expect(createShopifyProduct).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("done");
    expect(job.shopifyId).toBe("123");
  });

  it("fires a new_product social draft (with the primary SKU) after a successful import", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });

    await importToShopify("job-1");

    // The draft trigger is fire-and-forget via a dynamic import, so wait for the
    // floating promise to flush before asserting.
    await vi.waitFor(() => expect(triggerNewProduct).toHaveBeenCalledWith("S1"));
  });
});

describe("importToShopify — pre-publish quality gate", () => {
  it("does not push to Shopify when the pre-publish gate fails", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(runQualityGates).mockResolvedValueOnce({
      passed: false,
      failures: ["not_french"],
    } as never);

    const job = await importToShopify("job-1");

    expect(job.status).toBe("needs_review");
    expect(createShopifyProduct).not.toHaveBeenCalled();
    expect(updateImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "needs_review", error: "pre_publish_gate_failed:not_french" }),
    );
  });

  it("reports every failing gate in the stored error, comma-separated", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(runQualityGates).mockResolvedValueOnce({
      passed: false,
      failures: ["image_not_clean", "not_french", "brand_leak"],
    } as never);

    await importToShopify("job-1");

    expect(updateImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ error: "pre_publish_gate_failed:image_not_clean,not_french,brand_leak" }),
    );
  });

  it("pushes normally when the pre-publish gate passes (default mock)", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });

    const job = await importToShopify("job-1");

    expect(createShopifyProduct).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("done");
  });
});

describe("importToShopify — post-publish quality safety net", () => {
  it("unpublishes and marks needs_review when the post-publish check fails", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });
    vi.mocked(fetchShopifyProductContent).mockResolvedValueOnce({
      title: "Some drifted title",
      bodyHtml: "<p>drifted</p>",
      images: ["https://cdn/drifted.jpg"],
      tags: ["patio"],
    });
    // First call (pre-publish) passes, second call (post-publish) fails.
    vi.mocked(runQualityGates)
      .mockResolvedValueOnce({ passed: true, failures: [] } as never)
      .mockResolvedValueOnce({ passed: false, failures: ["brand_leak"] } as never);

    const job = await importToShopify("job-1");

    expect(job.status).toBe("needs_review");
    expect(job.shopifyId).toBe("123"); // the product WAS created, then pulled back
    expect(unpublishShopifyProduct).toHaveBeenCalledWith(
      "123",
      expect.objectContaining({ deactivate: true, tags: expect.arrayContaining(["patio", "exclude-stale", "needs-review"]) }),
    );
    expect(updateImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "needs_review", error: "post_publish_gate_failed:brand_leak" }),
    );
  });

  it("checks what Shopify actually serves, not the generated content", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });

    await importToShopify("job-1");

    expect(fetchShopifyProductContent).toHaveBeenCalledWith("123");
  });

  it("leaves the product published when the check itself errors (best-effort, does not fail the import)", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });
    vi.mocked(fetchShopifyProductContent).mockRejectedValueOnce(new Error("Shopify 500"));

    const job = await importToShopify("job-1");

    expect(job.status).toBe("done");
    expect(unpublishShopifyProduct).not.toHaveBeenCalled();
  });

  it("stays done when the post-publish check passes (default mock)", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ shopify_id: null }));
    vi.mocked(createShopifyProduct).mockResolvedValue({ id: "123", handle: "test-handle" });

    const job = await importToShopify("job-1");

    expect(job.status).toBe("done");
    expect(unpublishShopifyProduct).not.toHaveBeenCalled();
  });
});

describe("queueForImport — existing-SKU guard", () => {
  it("skips a SKU already mapped to a Shopify product, and reports why", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "S1" }] as never);
    vi.mocked(mergeVariants).mockReturnValue([
      { groupKey: "G1", productType: "X", images: [], variants: [{ sku: "S1" }] },
    ] as never);
    vi.mocked(getProduct).mockResolvedValue({ shopify_product_id: "555" } as never);

    const { jobs, skipped } = await queueForImport(["S1"]);

    expect(jobs).toHaveLength(0);
    expect(skipped).toEqual([{ sku: "S1", reason: "already_imported" }]);
    expect(upsertImportJob).not.toHaveBeenCalled();
    // The already-imported SKU is filtered out BEFORE mergeVariants runs — see the
    // mixed-batch describe block below for why that ordering is the fix, not a detail.
    expect(mergeVariants).not.toHaveBeenCalled();
  });

  it("queues a SKU that is not yet in Shopify", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "S2" }] as never);
    vi.mocked(mergeVariants).mockReturnValue([
      { groupKey: "G2", productType: "X", images: [], variants: [{ sku: "S2" }] },
    ] as never);
    vi.mocked(getProduct).mockResolvedValue(null);

    const { jobs, skipped } = await queueForImport(["S2"]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].groupKey).toBe("G2");
    expect(skipped).toEqual([]);
    expect(upsertImportJob).toHaveBeenCalledTimes(1);
  });
});

describe("queueForImport — mixed batch: already-imported variant + new sibling, same PSIN group", () => {
  // Regression for the live-confirmed bug (2026-09-19): submitting 501-004PK
  // (already on Shopify) together with 501-004BK (never imported, same merged
  // group) used to drop BOTH — the post-merge guard saw one already-imported
  // variant anywhere in the merged product and discarded the whole group,
  // silently, with the API still answering 200 and 0 jobs. The fix filters
  // per-SKU BEFORE mergeVariants ever sees the already-imported SKU.
  it("queues the never-imported sibling and reports only the already-imported one as skipped (501-004PK + 501-004BK)", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([
      { sku: "501-004PK" },
      { sku: "501-004BK" },
    ] as never);
    // Mirrors real mergeVariants: folds whatever it's handed into one merged
    // group. Because the fix filters already-imported SKUs out first, this is
    // called with ONLY 501-004BK — never with 501-004PK included.
    vi.mocked(mergeVariants).mockImplementation(
      (products: unknown) =>
        [
          {
            groupKey: "501-004",
            productType: "X",
            images: [],
            variants: products,
          },
        ] as never,
    );
    vi.mocked(getProduct).mockImplementation(async (sku: unknown) =>
      sku === "501-004PK" ? ({ shopify_product_id: "555" } as never) : (null as never),
    );

    const { jobs, skipped } = await queueForImport(["501-004PK", "501-004BK"]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].groupKey).toBe("501-004");
    expect(jobs[0].product.variants).toEqual([{ sku: "501-004BK" }]);
    expect(skipped).toEqual([{ sku: "501-004PK", reason: "already_imported" }]);
    expect(upsertImportJob).toHaveBeenCalledTimes(1);
    // mergeVariants must never have seen the already-imported SKU.
    expect(mergeVariants).toHaveBeenCalledWith([{ sku: "501-004BK" }]);
  });
});

describe("queueForImport — SKU vanished from the Aosom feed", () => {
  // Regression for the live-confirmed bug (2026-09-19): 840-158GN was catalogued
  // earlier but the supplier had discontinued it by the time the operator clicked
  // Confirm. Before this fix, a requested SKU absent from fetchAosomCatalog() just
  // never appeared in `matched` — 0 jobs, 200 OK, no trace of why.
  it("reports a not-in-feed SKU as skipped instead of silently producing 0 jobs (840-158GN)", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([] as never); // feed no longer carries it
    vi.mocked(mergeVariants).mockReturnValue([] as never);
    vi.mocked(getProduct).mockResolvedValue(null);

    const { jobs, skipped } = await queueForImport(["840-158GN"]);

    expect(jobs).toHaveLength(0);
    expect(skipped).toEqual([{ sku: "840-158GN", reason: "not_in_feed" }]);
    expect(upsertImportJob).not.toHaveBeenCalled();
    // getProduct is the already-imported check — a feed-gone SKU must never reach it.
    expect(getProduct).not.toHaveBeenCalled();
  });

  it("reports only the vanished SKU when submitted alongside a still-live one", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "840-158OG" }] as never);
    vi.mocked(mergeVariants).mockReturnValue([
      { groupKey: "840-158", productType: "X", images: [], variants: [{ sku: "840-158OG" }] },
    ] as never);
    vi.mocked(getProduct).mockResolvedValue(null);

    const { jobs, skipped } = await queueForImport(["840-158GN", "840-158OG"]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].groupKey).toBe("840-158");
    expect(skipped).toEqual([{ sku: "840-158GN", reason: "not_in_feed" }]);
  });
});

describe("generateContent — stored-content reuse guard (LLM cost)", () => {
  const validContent = JSON.stringify({
    titleFr: "Chaise longue",
    titleEn: "Lounge chair",
    descriptionFr: "<p>fr</p>",
    descriptionEn: "<p>en</p>",
    tags: [],
  });

  it("reuses a job's stored content instead of paying for a second generation", async () => {
    // import_jobs.group_key is UNIQUE per PSIN group, and upsertImportJob resets a
    // re-queued group to 'pending' WITHOUT clearing content — that is the path this guards.
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ status: "pending", content: validContent }));

    const job = await generateContent("job-1");

    expect(generateProductContent).not.toHaveBeenCalled();
    expect(job.status).toBe("reviewing");
    expect(job.content?.titleFr).toBe("Chaise longue");
  });

  it("regenerates when the caller explicitly forces it", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ status: "pending", content: validContent }));
    vi.mocked(generateProductContent).mockResolvedValue({ titleFr: "Neuf" } as never);

    await generateContent("job-1", { force: true });

    expect(generateProductContent).toHaveBeenCalledTimes(1);
  });

  it("regenerates when there is no stored content", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ status: "pending", content: null }));
    vi.mocked(generateProductContent).mockResolvedValue({ titleFr: "Neuf" } as never);

    await generateContent("job-1");

    expect(generateProductContent).toHaveBeenCalledTimes(1);
  });

  it("regenerates rather than trusting a stored payload that is corrupt", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ status: "pending", content: "{not json" }));
    vi.mocked(generateProductContent).mockResolvedValue({ titleFr: "Neuf" } as never);

    await generateContent("job-1");

    expect(generateProductContent).toHaveBeenCalledTimes(1);
  });

  it("regenerates rather than trusting a stored payload missing required fields", async () => {
    vi.mocked(getImportJob).mockResolvedValue(makeJobRow({ status: "pending", content: '{"tags":[]}' }));
    vi.mocked(generateProductContent).mockResolvedValue({ titleFr: "Neuf" } as never);

    await generateContent("job-1");

    expect(generateProductContent).toHaveBeenCalledTimes(1);
  });
});

describe("generateContent — an already-pushed job keeps its status", () => {
  it("does not move a 'done' job back to 'reviewing' when reusing its content", async () => {
    const content = JSON.stringify({ titleFr: "Chaise", descriptionFr: "<p>fr</p>", tags: [] });
    vi.mocked(getImportJob).mockResolvedValue(
      makeJobRow({ status: "done", shopify_id: "999", content }),
    );

    const job = await generateContent("job-1");

    expect(generateProductContent).not.toHaveBeenCalled();
    expect(updateImportJob).not.toHaveBeenCalled();
    expect(job.status).toBe("done");
    expect(job.shopifyId).toBe("999");
  });
});
