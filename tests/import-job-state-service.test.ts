/**
 * classifyAllImportJobs — the renamed-SKU fix (2026-09-30).
 *
 * import_jobs.product_data freezes the SKU string at import time. When Aosom later corrects
 * that SKU's colour/variant suffix (confirmed happening routinely — e.g. 84B-206BU became
 * 84B-206BK, same product, still selling normally), the frozen snapshot goes stale while the
 * product keeps selling under the new string. Classifying by the frozen SKU alone reads this
 * as "gone from the feed" — a false positive. These lock that classifyAllImportJobs instead
 * looks up feed rows by the job's RESOLVED Shopify id, so whichever SKU currently carries the
 * link is what decides freshness.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/import-pipeline", () => ({ getImportJobsList: vi.fn() }));
vi.mock("@/lib/database", () => ({ getFeedRowsForSkus: vi.fn(), getFeedRowsByShopifyIds: vi.fn() }));
vi.mock("@/lib/shopify-client", () => ({ fetchAllProductStates: vi.fn() }));

import { getImportJobsList } from "@/lib/import-pipeline";
import { getFeedRowsForSkus, getFeedRowsByShopifyIds } from "@/lib/database";
import { fetchAllProductStates } from "@/lib/shopify-client";
import { classifyAllImportJobs } from "@/lib/import-job-state-service";

const NOW = 1_790_800_000;
const DAY = 86_400;

const job = (over: Partial<{ id: string; status: string; shopifyId: string | null; sku: string }> = {}) => ({
  id: over.id ?? "job-1",
  groupKey: "g1",
  product: { variants: [{ sku: over.sku ?? "OLD-SKU" }] },
  status: over.status ?? "done",
  content: null,
  shopifyId: over.shopifyId ?? "123",
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("classifyAllImportJobs — feed presence by resolved Shopify id, not the frozen SKU", () => {
  it("a renamed SKU: frozen snapshot is stale, but the CURRENT linked SKU is fresh+in stock → live, not a problem", async () => {
    vi.mocked(getImportJobsList).mockResolvedValue([job({ shopifyId: "123", sku: "84B-206BU" })] as never);
    // The frozen sku's own row is long gone from the feed.
    vi.mocked(getFeedRowsForSkus).mockResolvedValue([
      { sku: "84B-206BU", qty: 0, lastSeenAt: NOW - 60 * DAY, shopifyProductId: null },
    ]);
    // But the product's CURRENT variant SKU (renamed by Aosom) is fresh and in stock.
    vi.mocked(getFeedRowsByShopifyIds).mockResolvedValue(new Map([
      ["123", [{ sku: "84B-206BK", qty: 18, lastSeenAt: NOW - DAY }]],
    ]));
    vi.mocked(fetchAllProductStates).mockResolvedValue(new Map([["123", { status: "active", published: true, tags: [] }]]));

    const [result] = await classifyAllImportJobs(NOW);
    expect(result.state).toMatchObject({ shopify: "live", feed: "in_stock", bucket: "live" });
  });

  it("falls back to the frozen snapshot when nothing is currently linked to the resolved id", async () => {
    vi.mocked(getImportJobsList).mockResolvedValue([job({ shopifyId: "123", sku: "SKU-A" })] as never);
    vi.mocked(getFeedRowsForSkus).mockResolvedValue([
      { sku: "SKU-A", qty: 5, lastSeenAt: NOW - DAY, shopifyProductId: null },
    ]);
    vi.mocked(getFeedRowsByShopifyIds).mockResolvedValue(new Map()); // no reverse-linked row yet
    vi.mocked(fetchAllProductStates).mockResolvedValue(new Map([["123", { status: "active", published: true, tags: [] }]]));

    const [result] = await classifyAllImportJobs(NOW);
    expect(result.state).toMatchObject({ feed: "in_stock" }); // used the frozen row, unaffected
  });

  it("a genuinely discontinued product (no sibling anywhere fresh) still reads as a problem", async () => {
    vi.mocked(getImportJobsList).mockResolvedValue([job({ shopifyId: "123", sku: "DEAD-SKU" })] as never);
    vi.mocked(getFeedRowsForSkus).mockResolvedValue([
      { sku: "DEAD-SKU", qty: 0, lastSeenAt: NOW - 60 * DAY, shopifyProductId: null },
    ]);
    vi.mocked(getFeedRowsByShopifyIds).mockResolvedValue(new Map([
      ["123", [{ sku: "DEAD-SKU", qty: 0, lastSeenAt: NOW - 60 * DAY }]],
    ]));
    vi.mocked(fetchAllProductStates).mockResolvedValue(new Map([["123", { status: "active", published: true, tags: [] }]]));

    const [result] = await classifyAllImportJobs(NOW);
    expect(result.state).toMatchObject({ bucket: "problem", feed: "gone" });
  });
});
