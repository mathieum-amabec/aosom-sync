import { describe, it, expect } from "vitest";
import {
  classifyImportJob,
  planImportJobFix,
  feedPresence,
  FEED_FRESH_SECS,
  type FeedRow,
  type JobInput,
  type ShopifyProductState,
} from "@/lib/import-job-state";

const NOW = 1_790_800_000;
const fresh = NOW - 3600;
const stale = NOW - FEED_FRESH_SECS - 3600;

const row = (o: Partial<FeedRow> = {}): FeedRow => ({ sku: "A", qty: 5, lastSeenAt: fresh, shopifyProductId: null, ...o });
const job = (o: Partial<JobInput> = {}): JobInput => ({ status: "pending", shopifyId: null, error: null, skus: ["A"], ...o });
const states = (entries: [string, Partial<ShopifyProductState>][]) =>
  new Map<string, ShopifyProductState>(entries.map(([id, s]) => [id, { status: "active", published: true, tags: [], ...s }]));

describe("feedPresence", () => {
  it("in stock / out of stock / gone / unknown", () => {
    expect(feedPresence([row()], NOW)).toBe("in_stock");
    expect(feedPresence([row({ qty: 0 })], NOW)).toBe("out_of_stock");
    expect(feedPresence([row({ lastSeenAt: stale })], NOW)).toBe("gone");
    expect(feedPresence([], NOW)).toBe("unknown");
  });

  it("one fresh in-stock variant is enough, stale variants are ignored", () => {
    expect(feedPresence([row({ sku: "A", lastSeenAt: stale, qty: 9 }), row({ sku: "B", qty: 0 })], NOW)).toBe("out_of_stock");
    expect(feedPresence([row({ sku: "A", qty: 0 }), row({ sku: "B", qty: 3 })], NOW)).toBe("in_stock");
  });
});

describe("classifyImportJob", () => {
  it("a 'pending' job whose product is live on Shopify is live, not to import", () => {
    const s = classifyImportJob(job({ shopifyId: "1" }), [row()], states([["1", {}]]), NOW);
    expect(s).toMatchObject({ shopify: "live", bucket: "live", shopifyId: "1" });
  });

  it("draft or unpublished + in stock → hidden_in_stock (republish candidate)", () => {
    expect(classifyImportJob(job({ shopifyId: "1" }), [row()], states([["1", { status: "draft", published: false }]]), NOW).bucket).toBe("hidden_in_stock");
    expect(classifyImportJob(job({ shopifyId: "1" }), [row()], states([["1", { published: false }]]), NOW).bucket).toBe("hidden_in_stock");
  });

  it("hidden with an intentional tag, or gone from the feed → hidden_intentional", () => {
    expect(classifyImportJob(job({ shopifyId: "1" }), [row()], states([["1", { status: "draft", published: false, tags: ["auto-drafted"] }]]), NOW).bucket).toBe("hidden_intentional");
    expect(classifyImportJob(job({ shopifyId: "1" }), [row({ lastSeenAt: stale })], states([["1", { status: "draft", published: false }]]), NOW).bucket).toBe("hidden_intentional");
  });

  it("live but gone from the Aosom feed is a problem", () => {
    expect(classifyImportJob(job({ shopifyId: "1" }), [row({ lastSeenAt: stale })], states([["1", {}]]), NOW).bucket).toBe("problem");
  });

  it("dead job id but the SKU now lives on another product → follows the SKU", () => {
    const s = classifyImportJob(job({ status: "done", shopifyId: "9" }), [row({ shopifyProductId: "2" })], states([["2", {}]]), NOW);
    expect(s).toMatchObject({ shopifyId: "2", shopify: "live", bucket: "live" });
  });

  it("dead job id and nothing on Shopify → deleted problem", () => {
    expect(classifyImportJob(job({ status: "done", shopifyId: "9" }), [row()], states([]), NOW)).toMatchObject({ shopify: "deleted", bucket: "problem" });
  });

  it("never created: to_import, unless gone from the feed or in error", () => {
    expect(classifyImportJob(job(), [row()], states([]), NOW)).toMatchObject({ shopify: "not_created", bucket: "to_import" });
    expect(classifyImportJob(job(), [row({ lastSeenAt: stale })], states([]), NOW).bucket).toBe("problem");
    expect(classifyImportJob(job({ status: "error", error: "boom" }), [row()], states([]), NOW)).toMatchObject({ bucket: "problem", reason: "boom" });
  });

  it("needs_review is always a problem, even when live", () => {
    expect(classifyImportJob(job({ status: "needs_review", shopifyId: "1" }), [row()], states([["1", {}]]), NOW).bucket).toBe("problem");
  });
});

describe("planImportJobFix", () => {
  const plan = (j: JobInput, rows: FeedRow[], st: Map<string, ShopifyProductState>) =>
    planImportJobFix("job", j, classifyImportJob(j, rows, st, NOW));

  it("unfinished job already on Shopify → done, error cleared", () => {
    expect(plan(job({ status: "reviewing", shopifyId: "1" }), [row()], states([["1", {}]]))?.set).toEqual({ status: "done", error: null });
    expect(plan(job({ status: "error", error: "x", shopifyId: "1" }), [row()], states([["1", { status: "draft", published: false }]]))?.set).toEqual({ status: "done", error: null });
  });

  it("job without an id whose SKU is on Shopify → done + linked", () => {
    expect(plan(job({ status: "error" }), [row({ shopifyProductId: "2" })], states([["2", {}]]))?.set).toEqual({ status: "done", error: null, shopify_id: "2" });
  });

  it("done job with a dead id → relinked only", () => {
    expect(plan(job({ status: "done", shopifyId: "9" }), [row({ shopifyProductId: "2" })], states([["2", {}]]))?.set).toEqual({ shopify_id: "2" });
  });

  it("dead id and nothing on Shopify → back to pending, link removed", () => {
    expect(plan(job({ status: "reviewing", shopifyId: "9" }), [row()], states([]))?.set).toEqual({ status: "pending", shopify_id: null, error: null });
  });

  it("no change when already consistent, never touches needs_review", () => {
    expect(plan(job({ status: "done", shopifyId: "1" }), [row()], states([["1", {}]]))).toBeNull();
    expect(plan(job({ status: "pending" }), [row()], states([]))).toBeNull();
    expect(plan(job({ status: "needs_review", shopifyId: "9" }), [row()], states([]))).toBeNull();
  });
});
