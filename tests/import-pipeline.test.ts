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
}));

import { importToShopify, queueForImport } from "@/lib/import-pipeline";
import { createShopifyProduct } from "@/lib/shopify-client";
import { getImportJob, getProduct, upsertImportJob } from "@/lib/database";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { mergeVariants } from "@/lib/variant-merger";

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
    vi.mocked(createShopifyProduct).mockResolvedValue("123");

    const job = await importToShopify("job-1");

    expect(createShopifyProduct).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("done");
    expect(job.shopifyId).toBe("123");
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
