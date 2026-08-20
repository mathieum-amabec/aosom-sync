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
import { createShopifyProduct } from "@/lib/shopify-client";
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

describe("queueForImport — existing-SKU guard", () => {
  it("skips a SKU already mapped to a Shopify product", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "S1" }] as never);
    vi.mocked(mergeVariants).mockReturnValue([
      { groupKey: "G1", productType: "X", images: [], variants: [{ sku: "S1" }] },
    ] as never);
    vi.mocked(getProduct).mockResolvedValue({ shopify_product_id: "555" } as never);

    const jobs = await queueForImport(["S1"]);

    expect(jobs).toHaveLength(0);
    expect(upsertImportJob).not.toHaveBeenCalled();
  });

  it("queues a SKU that is not yet in Shopify", async () => {
    vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "S2" }] as never);
    vi.mocked(mergeVariants).mockReturnValue([
      { groupKey: "G2", productType: "X", images: [], variants: [{ sku: "S2" }] },
    ] as never);
    vi.mocked(getProduct).mockResolvedValue(null);

    const jobs = await queueForImport(["S2"]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].groupKey).toBe("G2");
    expect(upsertImportJob).toHaveBeenCalledTimes(1);
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
