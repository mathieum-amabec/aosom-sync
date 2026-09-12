/**
 * Tests for job1-sync.ts — guard rails, chunking, checkpoint resume.
 *
 * Covers 6 scenarios:
 * 1. runSync completes normally → status="completed"
 * 2. runSync throws mid-flight → catch marks status="failed" (never "running")
 * 3. runSync with stale "running" run → clearStaleLockIfNeeded called, new run created
 * 4. runShopifyPush with valid today checkpoint → resumes from processedGroupKeys
 * 5. runShopifyPush with expired checkpoint (yesterday) → ignores checkpoint, starts fresh
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncRun, FieldChange } from "@/types/sync";
import type { AosomMergedProduct, AosomProduct } from "@/types/aosom";
import type { Phase1BlobProductRow } from "@/lib/sync-blob-storage";

// ─── Stable mock values ───────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function makeSyncRun(overrides: Partial<{
  id: string; status: string; startedAt: string; completedAt: string | null;
  totalProducts: number; updated: number; errors: number; errorMessages: string[];
}> = {}) {
  return {
    id: "run-abc",
    status: "completed",
    startedAt: `${TODAY}T06:00:00.000Z`,
    completedAt: `${TODAY}T06:04:00.000Z`,
    totalProducts: 100,
    created: 0, updated: 2, archived: 0, errors: 0,
    errorMessages: [],
    ...overrides,
  };
}

/**
 * A feed of `n` products plus the DB snapshot that exactly matches it, so
 * diffProductsLight yields zero inserts and zero updates.
 *
 * This is what "a quiet day" really looks like, and it is NOT an empty feed — the two
 * were interchangeable in these tests until 2026-09-12, when the difference turned out
 * to be 30 unpublished products.
 */
function makeUnchangedFeed(n: number) {
  const products: AosomProduct[] = Array.from({ length: n }, (_, i) => ({
    sku: `SKU-${i}`, name: `Produit ${i}`, price: 10 + i, qty: 5, color: "", size: "",
    productType: "Test", images: [], video: "", description: "", shortDescription: "",
    material: "", gtin: "", weight: 1, estimatedArrival: "", outOfStockExpected: "",
    packageNum: "", boxSize: "", boxWeight: "",
    dimensions: { length: 1, width: 1, height: 1 },
    category: "Test", brand: "TestBrand", psin: "", sin: "", pdf: "",
  }));
  const snapshot = new Map(products.map((p) => [p.sku, {
    sku: p.sku, name: p.name, price: p.price, qty: p.qty, color: "", size: "",
    product_type: p.productType, image1: "", image2: "", image3: "", image4: "",
    image5: "", image6: "", image7: "", video: "", description: "", short_description: "",
    material: "", gtin: "", weight: p.weight, out_of_stock_expected: "", estimated_arrival: "",
  }]));
  return { products, snapshot };
}

function makeProductDiff(groupKey: string, action: "update" | "archive" = "update") {
  return {
    shopifyId: "shop-" + groupKey,
    groupKey,
    productName: "Product " + groupKey,
    action,
    changes: [{ field: "price" as const, sku: groupKey + "-BK", oldValue: 100, newValue: 90 }],
    aosomProduct: null,
  };
}

// ─── Module mocks (declared before imports) ───────────────────────────

vi.mock("@/lib/database", () => ({
  clearStaleLockIfNeeded: vi.fn().mockResolvedValue(undefined),
  getLatestSyncRun: vi.fn().mockResolvedValue(null),
  createSyncRun: vi.fn().mockResolvedValue({ id: "run-new", startedAt: new Date().toISOString() }),
  completeSyncRun: vi.fn().mockResolvedValue(undefined),
  updateSyncRunTiming: vi.fn().mockResolvedValue(undefined),
  addSyncLogsBatch: vi.fn().mockResolvedValue(undefined),
  refreshProducts: vi.fn().mockResolvedValue(undefined),
  markSkusSeen: vi.fn().mockResolvedValue(0),
  rebuildProductTypeCounts: vi.fn().mockResolvedValue(undefined),
  recordPriceChanges: vi.fn().mockResolvedValue(undefined),
  getProduct: vi.fn().mockResolvedValue(null),
  getProductsSnapshot: vi.fn().mockResolvedValue(new Map()),
  getSetting: vi.fn().mockResolvedValue(null),
  createNotification: vi.fn().mockResolvedValue(1),
  getAllProductsAsAosom: vi.fn().mockResolvedValue([]),
  getShopifyPushCheckpoint: vi.fn().mockResolvedValue(null),
  saveShopifyPushCheckpoint: vi.fn().mockResolvedValue(undefined),
  getPhase1Checkpoint: vi.fn().mockResolvedValue(null),
  savePhase1Checkpoint: vi.fn().mockResolvedValue(undefined),
  getSyncRuns: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/sync-blob-storage", () => ({
  savePhase1Blob: vi.fn().mockResolvedValue("https://blob.vercel-storage.com/test/run-new.json"),
  readPhase1Blob: vi.fn().mockResolvedValue({ toWriteMapped: [], priceChangeEntries: [] }),
  deletePhase1Blob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sync-lock", () => ({
  tryAcquireSyncLock: vi.fn().mockResolvedValue("test-holder"),
  releaseSyncLock: vi.fn().mockResolvedValue(undefined),
  getSyncLockStatus: vi.fn().mockResolvedValue(null),
  SYNC_LOCK_KEY: "sync_full_lock",
  SYNC_LOCK_TTL_SECONDS: 900,
}));

vi.mock("@/lib/csv-fetcher", () => ({
  fetchAosomCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/shopify-client", () => ({
  fetchAllShopifyProducts: vi.fn().mockResolvedValue([]),
  updateShopifyProduct: vi.fn().mockResolvedValue(undefined),
  updateShopifyVariantPrice: vi.fn().mockResolvedValue(undefined),
  draftShopifyProduct: vi.fn().mockResolvedValue(undefined),
  createShopifyProduct: vi.fn().mockResolvedValue("new-shopify-id"),
  addProductToCollection: vi.fn().mockResolvedValue(undefined),
  getProductCollections: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/variant-merger", () => ({
  mergeVariants: vi.fn().mockReturnValue([]),
  stripColorFromTitle: vi.fn((t: string) => t),
}));

vi.mock("@/lib/diff-engine", () => ({
  computeDiffs: vi.fn().mockReturnValue([]),
  summarizeDiffs: vi.fn().mockReturnValue({ updates: 0, archives: 0, creates: 0 }),
  // applyToShopify's tags branch calls these two. Without them the branch throws and is
  // swallowed by its try/catch, which silently turns any tags-branch assertion vacuous.
  productInStock: vi.fn().mockReturnValue(true),
  applyStockTags: vi.fn((tags: string[]) => [...tags.filter((t) => t !== "out-of-stock"), "back-in-stock"]),
}));

vi.mock("@/lib/config", () => ({
  env: { shopifyAccessToken: "test", hasShopifyToken: true, anthropicApiKey: "test", cronSecret: "test" },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  SYNC: { MAX_PRODUCTS: 10000, PRICE_CHANGE_NOTIFICATION_THRESHOLD: 5 },
  CLAUDE: { MODEL: "claude-sonnet-4-6", MODEL_BATCH: "claude-haiku-4-5", MAX_TOKENS_CONTENT: 2048 },
  AUTH: {
    COOKIE_NAME: "aosom_session",
    SESSION_MAX_AGE: 604800,
    ROLES: ["admin", "reviewer"],
    REVIEWER_ALLOWED_PREFIXES: ["/social", "/settings", "/api/social", "/api/settings", "/api/auth", "/api/health", "/privacy"],
  },
}));

// Import AFTER mocks are declared
const db = await import("@/lib/database");
const shopifyClient = await import("@/lib/shopify-client");
const diffEngine = await import("@/lib/diff-engine");
const blobStorage = await import("@/lib/sync-blob-storage");
const syncLock = await import("@/lib/sync-lock");
const csvFetcher = await import("@/lib/csv-fetcher");
const { runSync, runShopifyPush, runSyncInit, runSyncRefreshChunk, runSyncFinalize, runSyncFull } = await import("@/jobs/job1-sync");

// ─── Test utilities ───────────────────────────────────────────────────

function resetAllMocks() {
  vi.clearAllMocks(); // reset call counts between tests
  vi.mocked(db.clearStaleLockIfNeeded).mockResolvedValue(undefined);
  vi.mocked(db.getLatestSyncRun).mockResolvedValue(null);
  vi.mocked(db.createSyncRun).mockResolvedValue({ id: "run-new", startedAt: new Date().toISOString() } as ReturnType<typeof db.createSyncRun> extends Promise<infer T> ? T : never);
  vi.mocked(db.completeSyncRun).mockResolvedValue(undefined);
  vi.mocked(db.addSyncLogsBatch).mockResolvedValue(undefined);
  vi.mocked(db.refreshProducts).mockResolvedValue(undefined);
  vi.mocked(db.markSkusSeen).mockResolvedValue(0);
  vi.mocked(db.rebuildProductTypeCounts).mockResolvedValue(undefined);
  vi.mocked(db.recordPriceChanges).mockResolvedValue(undefined);
  vi.mocked(db.createNotification).mockResolvedValue(1);
  vi.mocked(db.getAllProductsAsAosom).mockResolvedValue([]);
  // Default feed: a healthy catalogue with nothing changed (feed matches the snapshot), so
  // toWrite is empty exactly as before while the feed itself stays plausible. The previous
  // default was an EMPTY feed, which assertFeedPlausible now rejects — correctly: an empty
  // feed is indistinguishable from "the supplier withdrew everything", which is how 30 live
  // products got unpublished on 2026-09-12. Tests that want an empty feed now say so.
  const defaultFeed = makeUnchangedFeed(120);
  vi.mocked(csvFetcher.fetchAosomCatalog).mockResolvedValue(defaultFeed.products);
  vi.mocked(db.getProductsSnapshot).mockResolvedValue(defaultFeed.snapshot as Awaited<ReturnType<typeof db.getProductsSnapshot>>);
  vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue(null);
  vi.mocked(db.saveShopifyPushCheckpoint).mockResolvedValue(undefined);
  vi.mocked(db.getPhase1Checkpoint).mockResolvedValue(null);
  vi.mocked(db.savePhase1Checkpoint).mockResolvedValue(undefined);
  vi.mocked(blobStorage.savePhase1Blob).mockResolvedValue("https://blob.vercel-storage.com/test/run-new.json");
  vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({ toWriteMapped: [], priceChangeEntries: [] });
  vi.mocked(blobStorage.deletePhase1Blob).mockResolvedValue(undefined);
  vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue([]);
  vi.mocked(diffEngine.computeDiffs).mockReturnValue([]);
  vi.mocked(diffEngine.summarizeDiffs).mockReturnValue({ total: 0, updates: 0, archives: 0, creates: 0, priceChanges: 0, stockChanges: 0, tagChanges: 0, imageChanges: 0, descriptionChanges: 0 });
}

// ─── Scenario 1: runSync completes normally ───────────────────────────

describe("runSync — normal completion", () => {
  beforeEach(resetAllMocks);

  it("marks run completed and returns result", async () => {
    const result = await runSync({ shopifyPush: false });

    expect(db.createSyncRun).toHaveBeenCalledOnce();
    expect(db.completeSyncRun).toHaveBeenCalledWith(
      "run-new",
      expect.objectContaining({ status: "completed" })
    );
    expect(result.syncRunId).toBe("run-new");
    expect(result.dryRun).toBe(false);
    // timing written incrementally after each phase (8 calls: createSyncRun + 7 phases)
    expect(db.updateSyncRunTiming).toHaveBeenCalledWith("run-new", expect.any(Object));
    expect(vi.mocked(db.updateSyncRunTiming).mock.calls.length).toBeGreaterThanOrEqual(8);
  });

  it("calls clearStaleLockIfNeeded before creating a new run", async () => {
    await runSync({ shopifyPush: false });

    const clearOrder = vi.mocked(db.clearStaleLockIfNeeded).mock.invocationCallOrder[0];
    const createOrder = vi.mocked(db.createSyncRun).mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(createOrder);
  });

  it("calls fetchAllShopifyProducts when shopifyPush=true", async () => {
    await runSync({ shopifyPush: true });
    expect(shopifyClient.fetchAllShopifyProducts).toHaveBeenCalledOnce();
  });
});

// ─── Scenario 2: runSync throws → catch marks failed ─────────────────

describe("runSync — mid-flight error → status=failed", () => {
  beforeEach(resetAllMocks);

  it("marks run failed when fetchAosomCatalog throws", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    vi.mocked(fetchAosomCatalog).mockRejectedValueOnce(new Error("CSV fetch timeout"));

    await expect(runSync({ shopifyPush: false })).rejects.toThrow("CSV fetch timeout");

    expect(db.completeSyncRun).toHaveBeenCalledWith(
      "run-new",
      expect.objectContaining({ status: "failed", errors: 1 })
    );
    // timing written in catch block with total elapsed
    expect(db.updateSyncRunTiming).toHaveBeenCalledWith("run-new", expect.objectContaining({ total: expect.any(Number) }));
  });

  it("marks run failed when getProductsSnapshot throws", async () => {
    vi.mocked(db.getProductsSnapshot).mockRejectedValueOnce(new Error("Turso connection reset"));

    await expect(runSync({ shopifyPush: false })).rejects.toThrow("Turso connection reset");

    expect(db.completeSyncRun).toHaveBeenCalledWith(
      "run-new",
      expect.objectContaining({ status: "failed", errors: 1 })
    );
  });

  it("never leaves run in status=running after an error", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    vi.mocked(fetchAosomCatalog).mockRejectedValueOnce(new Error("network error"));

    await expect(runSync()).rejects.toThrow();

    const calls = vi.mocked(db.completeSyncRun).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toMatchObject({ status: "failed" });
    // status must never be "running" — the only setter is completeSyncRun
    for (const [, args] of calls) {
      expect(args.status).not.toBe("running");
    }
  });
});

// ─── Scenario 3: stale "running" run → cleared before new run ────────

describe("runSync — stale running run", () => {
  beforeEach(resetAllMocks);

  it("calls clearStaleLockIfNeeded when a running run exists", async () => {
    // Simulate: stale run was cleared by clearStaleLockIfNeeded, so getLatestSyncRun returns null
    vi.mocked(db.getLatestSyncRun).mockResolvedValue(null);

    await runSync({ shopifyPush: false });

    expect(db.clearStaleLockIfNeeded).toHaveBeenCalledOnce();
    expect(db.createSyncRun).toHaveBeenCalledOnce();
  });

  it("throws if a running run is still present after clearing (concurrent sync)", async () => {
    // Simulate: clearStaleLockIfNeeded ran but run is still "running" (started <30 min ago)
    vi.mocked(db.getLatestSyncRun).mockResolvedValue(
      makeSyncRun({ id: "run-stuck", status: "running", completedAt: null }) as unknown as SyncRun
    );

    await expect(runSync()).rejects.toThrow(/already in progress/i);

    // createSyncRun must NOT have been called — no duplicate run
    expect(db.createSyncRun).not.toHaveBeenCalled();
  });
});

// ─── Scenario 4: runShopifyPush — valid today checkpoint → resume ─────

describe("runShopifyPush — valid checkpoint (today) → resume", () => {
  beforeEach(resetAllMocks);

  it("skips already-processed groupKeys and processes only remaining chunk", async () => {
    // 5 diffs: first 2 already processed
    const allDiffs = ["gk-A", "gk-B", "gk-C", "gk-D", "gk-E"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(allDiffs);

    const checkpoint = {
      date: TODAY,
      processedGroupKeys: ["gk-A", "gk-B"],
      totalDiffs: 5,
      totalUpdates: 2,
      totalArchived: 0,
      totalErrors: 0,
      done: false,
    };
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue(checkpoint);

    await runShopifyPush();

    // saveShopifyPushCheckpoint should include gk-A, gk-B PLUS the new chunk
    const saved = vi.mocked(db.saveShopifyPushCheckpoint).mock.calls[0]?.[0];
    expect(saved).toBeDefined();
    // Must include the 2 previously processed keys
    expect(saved!.processedGroupKeys).toContain("gk-A");
    expect(saved!.processedGroupKeys).toContain("gk-B");
    // Must include at least gk-C (next in line)
    expect(saved!.processedGroupKeys).toContain("gk-C");
    // Total processed must be > 2 (resumed correctly)
    expect(saved!.processedGroupKeys.length).toBeGreaterThan(2);
  });

  it("marks done=true when all diffs have been processed", async () => {
    // 2 diffs, 1 already done → after this chunk: all done
    const allDiffs = ["gk-X", "gk-Y"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(allDiffs);

    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: TODAY,
      processedGroupKeys: ["gk-X"],
      totalDiffs: 2,
      totalUpdates: 1,
      totalArchived: 0,
      totalErrors: 0,
      done: false,
    });

    await runShopifyPush();

    const saved = vi.mocked(db.saveShopifyPushCheckpoint).mock.calls[0]?.[0];
    expect(saved!.done).toBe(true);
    expect(saved!.processedGroupKeys).toEqual(["gk-X", "gk-Y"]);
  });

  it("short-circuits immediately when checkpoint is already done", async () => {
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: TODAY,
      processedGroupKeys: ["gk-Z"],
      totalDiffs: 1,
      totalUpdates: 1,
      totalArchived: 0,
      totalErrors: 0,
      done: true,
    });

    const result = await runShopifyPush();

    // No sync run should be created — nothing to do
    expect(db.createSyncRun).not.toHaveBeenCalled();
    expect(result.updates).toBe(1);
  });
});

// ─── Scenario 5: runShopifyPush — expired checkpoint → start fresh ────

describe("runShopifyPush — expired checkpoint (yesterday) → fresh start", () => {
  beforeEach(resetAllMocks);

  it("ignores yesterday checkpoint and starts from the beginning", async () => {
    const allDiffs = ["gk-1", "gk-2", "gk-3"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(allDiffs);

    // Checkpoint from yesterday — should be ignored
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: YESTERDAY,
      processedGroupKeys: ["gk-1", "gk-2"], // already done yesterday
      totalDiffs: 3,
      totalUpdates: 2,
      totalArchived: 0,
      totalErrors: 0,
      done: false,
    });

    await runShopifyPush();

    const saved = vi.mocked(db.saveShopifyPushCheckpoint).mock.calls[0]?.[0];
    expect(saved).toBeDefined();
    // Must use today's date
    expect(saved!.date).toBe(TODAY);
    // Must NOT include yesterday's processedGroupKeys as pre-processed
    // (gk-1 should appear only if it was in the new chunk, not as a skip)
    // The processed set starts empty, so all 3 diffs are candidates for the chunk
    expect(saved!.processedGroupKeys.length).toBeGreaterThan(0);
    // The saved checkpoint uses today's date — yesterday's data is gone
    expect(saved!.date).not.toBe(YESTERDAY);
  });

  it("creates a new sync run even with an expired checkpoint", async () => {
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: YESTERDAY,
      processedGroupKeys: [],
      totalDiffs: 0,
      totalUpdates: 0,
      totalArchived: 0,
      totalErrors: 0,
      done: false,
    });

    const allDiffs = ["gk-A"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(allDiffs);

    await runShopifyPush();

    expect(db.createSyncRun).toHaveBeenCalledOnce();
  });
});
describe("runSync — dryRun=true", () => {
  beforeEach(resetAllMocks);

  it("completes without mutating products or pushing to Shopify", async () => {
    const result = await runSync({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(db.refreshProducts).not.toHaveBeenCalled();
    expect(shopifyClient.updateShopifyVariantPrice).not.toHaveBeenCalled();
  });

  it("marks run completed with DRY RUN message", async () => {
    await runSync({ dryRun: true });

    expect(db.completeSyncRun).toHaveBeenCalledWith(
      "run-new",
      expect.objectContaining({
        status: "completed",
        errorMessages: expect.arrayContaining(["DRY RUN — no changes applied"]),
      })
    );
  });
});

// ─── Scenario 8: runShopifyPush — catch block on internal error ───────

describe("runShopifyPush — catch block rethrows on DB failure", () => {
  beforeEach(resetAllMocks);

  it("rethrows when checkpoint save fails mid-chunk and marks run failed", async () => {
    const diffs = ["gk-err"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(diffs);
    vi.mocked(db.saveShopifyPushCheckpoint).mockRejectedValueOnce(new Error("DB write failed"));

    await expect(runShopifyPush()).rejects.toThrow("DB write failed");

    // completeSyncRun should be called at least once — with status=failed from the catch block
    const calls = vi.mocked(db.completeSyncRun).mock.calls;
    expect(calls.some(([, args]) => args.status === "failed")).toBe(true);
  });
});

// ─── Scenario 9: runShopifyPush — remaining.length === 0 ─────────────

describe("runShopifyPush — all diffs already processed", () => {
  beforeEach(resetAllMocks);

  it("saves done=true checkpoint and completes the sync run", async () => {
    const diffs = ["gk-1", "gk-2"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(diffs);
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: TODAY,
      processedGroupKeys: ["gk-1", "gk-2"],
      totalDiffs: 2, totalUpdates: 2, totalArchived: 0, totalErrors: 0, done: false,
    });

    await runShopifyPush();

    expect(db.createSyncRun).toHaveBeenCalledOnce();
    expect(db.completeSyncRun).toHaveBeenCalledWith(
      "run-new",
      expect.objectContaining({
        status: "completed",
        errorMessages: expect.arrayContaining(["Phase 2: no diffs remaining (checkpoint complete)"]),
      })
    );
    const saved = vi.mocked(db.saveShopifyPushCheckpoint).mock.calls[0]?.[0];
    expect(saved?.done).toBe(true);
  });
});

// ─── Test A: Fix #2 — runSync({shopifyPush:false}) skips Shopify fetch ──

describe("runSync — shopifyPush=false skips fetchAllShopifyProducts", () => {
  beforeEach(resetAllMocks);

  it("does not call fetchAllShopifyProducts when shopifyPush=false", async () => {
    await runSync({ shopifyPush: false });

    expect(shopifyClient.fetchAllShopifyProducts).not.toHaveBeenCalled();
  });
});

// ─── Test B: Fix #1 — createSyncRun called before fetch in runShopifyPush ──

describe("runShopifyPush — createSyncRun called before fetchAllShopifyProducts throws", () => {
  beforeEach(resetAllMocks);

  it("run is created in DB even when fetch throws (SIGKILL-safe)", async () => {
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockRejectedValueOnce(
      new Error("Shopify API timeout")
    );

    await expect(runShopifyPush()).rejects.toThrow("Shopify API timeout");

    expect(db.createSyncRun).toHaveBeenCalledOnce();
    expect(db.completeSyncRun).toHaveBeenCalledWith(
      "run-new",
      expect.objectContaining({ status: "failed" })
    );
    // Verify createSyncRun was called BEFORE fetchAllShopifyProducts — the core invariant
    const createOrder = vi.mocked(db.createSyncRun).mock.invocationCallOrder[0];
    const fetchOrder = vi.mocked(shopifyClient.fetchAllShopifyProducts).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(fetchOrder!);
  });
});

// ─── Test C: Fix #1 — cp.done=true early return skips createSyncRun ──────

describe("runShopifyPush — cp.done=true early return skips createSyncRun", () => {
  beforeEach(resetAllMocks);

  it("does not create a sync run when today's checkpoint is already done", async () => {
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: TODAY,
      processedGroupKeys: ["gk-1", "gk-2"],
      totalDiffs: 2, totalUpdates: 2, totalArchived: 0, totalErrors: 0, done: true,
    });

    await runShopifyPush();

    expect(db.createSyncRun).not.toHaveBeenCalled();
  });
});

// ─── Option α: diff-before-upsert tests ─────────────────────────────

describe("runSync — diff-before-upsert: refreshProducts called only for changed rows", () => {
  beforeEach(resetAllMocks);

  it("skips refreshProducts entirely when snapshot matches all CSV rows (all unchanged)", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    // One CSV product
    const csvProduct = {
      sku: "SKU-SAME", name: "A", price: 99.99, qty: 5, color: "", size: "",
      shortDescription: "", description: "", images: ["img.jpg", "", "", "", "", "", ""],
      gtin: "", weight: 0, dimensions: { length: 0, width: 0, height: 0 },
      productType: "", category: "", brand: "", material: "", psin: "", sin: "",
      video: "", estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "", pdf: "",
    };
    vi.mocked(fetchAosomCatalog).mockResolvedValueOnce([csvProduct]);

    // Snapshot matches exactly — all fields the same
    vi.mocked(db.getProductsSnapshot).mockResolvedValueOnce(new Map([
      ["SKU-SAME", {
        sku: "SKU-SAME", name: "A", price: 99.99, qty: 5,
        color: "", size: "", product_type: "",
        image1: "img.jpg", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "",
        video: "", description: "", short_description: "", material: "", gtin: "", weight: 0,
        out_of_stock_expected: "", estimated_arrival: "", shopify_product_id: null,
      }],
    ]));

    await runSync({ shopifyPush: false });

    // Nothing changed → refreshProducts should NOT be called
    expect(db.refreshProducts).not.toHaveBeenCalled();
    // Type counts and price history still run regardless
    expect(db.rebuildProductTypeCounts).toHaveBeenCalledOnce();
  });

  it("calls refreshProducts with only the changed subset (not all 10k rows)", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    // Two CSV products: one unchanged, one with a price change
    const unchanged = {
      sku: "SKU-OLD", name: "B", price: 50.00, qty: 3, color: "", size: "",
      shortDescription: "", description: "", images: ["", "", "", "", "", "", ""],
      gtin: "", weight: 0, dimensions: { length: 0, width: 0, height: 0 },
      productType: "", category: "", brand: "", material: "", psin: "", sin: "",
      video: "", estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "", pdf: "",
    };
    const changed = { ...unchanged, sku: "SKU-NEW-PRICE", price: 199.99 };
    vi.mocked(fetchAosomCatalog).mockResolvedValueOnce([unchanged, changed]);

    vi.mocked(db.getProductsSnapshot).mockResolvedValueOnce(new Map([
      ["SKU-OLD", { sku: "SKU-OLD", name: "B", price: 50.00, qty: 3, color: "", size: "", product_type: "", image1: "", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "", video: "", description: "", short_description: "", material: "", gtin: "", weight: 0, out_of_stock_expected: "", estimated_arrival: "", shopify_product_id: null }],
      ["SKU-NEW-PRICE", { sku: "SKU-NEW-PRICE", name: "B", price: 99.99, qty: 3, color: "", size: "", product_type: "", image1: "", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "", video: "", description: "", short_description: "", material: "", gtin: "", weight: 0, out_of_stock_expected: "", estimated_arrival: "", shopify_product_id: null }],
    ]));

    await runSync({ shopifyPush: false });

    // refreshProducts called once with only 1 product (the changed one)
    expect(db.refreshProducts).toHaveBeenCalledOnce();
    const calledWith = vi.mocked(db.refreshProducts).mock.calls[0][0];
    expect(calledWith).toHaveLength(1);
    expect(calledWith[0].sku).toBe("SKU-NEW-PRICE");
  });
});

// ─── Scenario 10: runShopifyPush — notification on isDone ────────────

describe("runShopifyPush — notification fired when phase 2 completes with work done", () => {
  beforeEach(resetAllMocks);

  it("creates success notification when isDone=true and accumulated updates > 0", async () => {
    const diffs = ["gk-final"].map(k => makeProductDiff(k));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(diffs);
    // Prior checkpoint: 5 updates already accumulated, this is the last chunk
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: TODAY,
      processedGroupKeys: [],
      totalDiffs: 1, totalUpdates: 5, totalArchived: 0, totalErrors: 0, done: false,
    });

    await runShopifyPush();

    expect(db.createNotification).toHaveBeenCalledWith(
      "success",
      "Shopify push terminé",
      expect.stringContaining("5 produits mis à jour")
    );
  });
});

// ─── Phase 1 chunked: runSyncInit ─────────────────────────────────────

describe("runSyncInit — normal flow with toWrite > 0", () => {
  beforeEach(resetAllMocks);

  it("saves blob, saves checkpoint, completes run, returns totalChunks=1 for 100 rows", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    const rows = Array.from({ length: 100 }, (_, i) => ({
      sku: `SKU-${i}`, name: `Product ${i}`, price: 99, qty: 10,
      color: "BK", size: "", shortDescription: "", description: "<p>desc</p>",
      images: [], gtin: "", weight: 1.0, dimensions: { length: 0, width: 0, height: 0 },
      productType: "Home", category: "", brand: "Aosom", material: "", psin: `P${i}`, sin: "",
      video: "", estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "", pdf: "",
    }));
    vi.mocked(fetchAosomCatalog).mockResolvedValue(rows);

    const result = await runSyncInit();

    expect(result.skipped).toBe(false);
    expect(result.totalChunks).toBe(1); // 100 rows < CHUNK_SIZE=2500
    expect(result.totalProducts).toBe(100);
    expect(blobStorage.savePhase1Blob).toHaveBeenCalledOnce();
    expect(db.savePhase1Checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ totalChunks: 1, chunksProcessed: 0, refreshDone: false, finalized: false })
    );
    expect(db.completeSyncRun).toHaveBeenCalledWith("run-new", expect.objectContaining({ status: "completed" }));
  });

  it("skips blob save and sets refreshDone=true when toWrite is empty", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    // "Nothing changed" is modelled as a POPULATED feed matching the snapshot, not as an
    // empty feed. Conflating the two is the 2026-09-12 bug: an empty feed now throws
    // (assertFeedPlausible), because it is indistinguishable from a withdrawn catalogue.
    const feed = makeUnchangedFeed(120);
    vi.mocked(fetchAosomCatalog).mockResolvedValue(feed.products);
    vi.mocked(db.getProductsSnapshot).mockResolvedValue(feed.snapshot as Awaited<ReturnType<typeof db.getProductsSnapshot>>);
    const result = await runSyncInit();

    expect(result.skipped).toBe(false);
    expect(result.totalChunks).toBe(0);
    expect(blobStorage.savePhase1Blob).not.toHaveBeenCalled();
    expect(db.savePhase1Checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ totalChunks: 0, refreshDone: true, finalized: false })
    );
  });

  it("skips and returns skipped=true if already finalized today", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "", totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: true,
      totalProducts: 100, priceUpdates: 5, stockChanges: 2, newProducts: 1,
    });

    const result = await runSyncInit();

    expect(result.skipped).toBe(true);
    expect(db.createSyncRun).not.toHaveBeenCalled();
    expect(blobStorage.savePhase1Blob).not.toHaveBeenCalled();
  });
});

// ─── Phase 1 chunked: runSyncRefreshChunk ────────────────────────────

describe("runSyncRefreshChunk — normal flow", () => {
  beforeEach(resetAllMocks);

  it("reads blob, writes chunk, advances chunksProcessed, marks refreshDone when last chunk", async () => {
    const mappedRows = Array.from({ length: 50 }, (_, i) => ({
      sku: `S${i}`, name: `P${i}`, price: 10, qty: 5, color: "", size: "", product_type: "Home",
      image1: "", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "",
      video: "", description: "", short_description: "", material: "", gtin: "", weight: 0,
      out_of_stock_expected: "", estimated_arrival: "", last_seen_at: 0,
    }));
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 1, chunksProcessed: 0,
      refreshDone: false, finalized: false,
      totalProducts: 50, priceUpdates: 2, stockChanges: 1, newProducts: 0,
    });
    vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({ toWriteMapped: mappedRows, priceChangeEntries: [] });

    const result = await runSyncRefreshChunk();

    expect(result.skipped).toBe(false);
    expect(result.chunksProcessed).toBe(1);
    expect(result.refreshDone).toBe(true);
    expect(db.refreshProducts).toHaveBeenCalledWith(mappedRows);
    expect(db.savePhase1Checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ chunksProcessed: 1, refreshDone: true })
    );
    expect(db.completeSyncRun).toHaveBeenCalledWith("run-new", expect.objectContaining({ status: "completed" }));
  });

  it("skips when no checkpoint for today", async () => {
    const result = await runSyncRefreshChunk();

    expect(result.skipped).toBe(true);
    expect(db.createSyncRun).not.toHaveBeenCalled();
    expect(db.refreshProducts).not.toHaveBeenCalled();
  });

  it("calls clearStaleLockIfNeeded(15) before createSyncRun — self-healing stale orphans", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 2, chunksProcessed: 0,
      refreshDone: false, finalized: false,
      totalProducts: 100, priceUpdates: 0, stockChanges: 5, newProducts: 0,
    });
    vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({ toWriteMapped: [], priceChangeEntries: [] });

    await runSyncRefreshChunk();

    expect(db.clearStaleLockIfNeeded).toHaveBeenCalledWith(15);
    const clearOrder = vi.mocked(db.clearStaleLockIfNeeded).mock.invocationCallOrder[0]!;
    const createOrder = vi.mocked(db.createSyncRun).mock.invocationCallOrder[0]!;
    expect(clearOrder).toBeLessThan(createOrder);
  });

  it("does not call clearStaleLockIfNeeded when no checkpoint today", async () => {
    await runSyncRefreshChunk();

    expect(db.clearStaleLockIfNeeded).not.toHaveBeenCalled();
  });

  it("skips when refreshDone is already true", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "", totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: false,
      totalProducts: 50, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });

    const result = await runSyncRefreshChunk();

    expect(result.skipped).toBe(true);
    expect(db.refreshProducts).not.toHaveBeenCalled();
  });
});

// ─── Phase 1 chunked: runSyncFinalize ────────────────────────────────

describe("runSyncFinalize — normal flow", () => {
  beforeEach(resetAllMocks);

  it("runs rebuildCounts + recordPriceChanges + completes run + cleans up blob", async () => {
    const priceEntries = [{ sku: "S1", oldPrice: 100, newPrice: 80, oldQty: 5, newQty: 5, changeType: "price_drop" as const }];
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: false,
      totalProducts: 50, priceUpdates: 1, stockChanges: 0, newProducts: 0,
    });
    vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({ toWriteMapped: [], priceChangeEntries: priceEntries });

    const result = await runSyncFinalize();

    expect(result.skipped).toBe(false);
    expect(db.rebuildProductTypeCounts).toHaveBeenCalledOnce();
    expect(db.recordPriceChanges).toHaveBeenCalledWith(priceEntries);
    expect(db.completeSyncRun).toHaveBeenCalledWith("run-new", expect.objectContaining({ status: "completed", totalProducts: 50 }));
    expect(blobStorage.deletePhase1Blob).toHaveBeenCalledWith("https://blob.test/run.json");
    expect(db.savePhase1Checkpoint).toHaveBeenCalledWith(expect.objectContaining({ finalized: true }));
    expect(db.createNotification).toHaveBeenCalledWith("success", "Sync Phase 1 finalisée", expect.any(String));
  });

  it("skips when refreshDone=false (chunks not yet complete)", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "", totalChunks: 2, chunksProcessed: 1,
      refreshDone: false, finalized: false,
      totalProducts: 5000, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });

    const result = await runSyncFinalize();

    expect(result.skipped).toBe(true);
    expect(db.rebuildProductTypeCounts).not.toHaveBeenCalled();
  });

  it("skips when no checkpoint for today", async () => {
    const result = await runSyncFinalize();

    expect(result.skipped).toBe(true);
    expect(db.createSyncRun).not.toHaveBeenCalled();
  });

  it("skips when already finalized today", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "", totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: true,
      totalProducts: 50, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });

    const result = await runSyncFinalize();

    expect(result.skipped).toBe(true);
    expect(db.rebuildProductTypeCounts).not.toHaveBeenCalled();
    expect(db.createSyncRun).not.toHaveBeenCalled();
  });

  it("continues without price history when blob read fails, still marks finalized", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: false,
      totalProducts: 50, priceUpdates: 3, stockChanges: 0, newProducts: 0,
    });
    vi.mocked(blobStorage.readPhase1Blob).mockRejectedValue(new Error("blob 404"));

    const result = await runSyncFinalize();

    expect(result.skipped).toBe(false);
    expect(db.rebuildProductTypeCounts).toHaveBeenCalledOnce();
    expect(db.recordPriceChanges).not.toHaveBeenCalled();
    expect(db.savePhase1Checkpoint).toHaveBeenCalledWith(expect.objectContaining({ finalized: true }));
    expect(db.createNotification).toHaveBeenCalledWith("success", "Sync Phase 1 finalisée", expect.any(String));
  });

  it("marks run failed and fires error notification when rebuildProductTypeCounts throws", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: false,
      totalProducts: 50, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });
    vi.mocked(db.rebuildProductTypeCounts).mockRejectedValueOnce(new Error("DB error"));

    await expect(runSyncFinalize()).rejects.toThrow("DB error");

    const calls = vi.mocked(db.completeSyncRun).mock.calls;
    expect(calls.some(([, args]) => args.status === "failed")).toBe(true);
    expect(db.createNotification).toHaveBeenCalledWith("error", "Sync finalize échouée", expect.stringContaining("DB error"));
    expect(db.savePhase1Checkpoint).not.toHaveBeenCalledWith(expect.objectContaining({ finalized: true }));
  });
});

// ─── Phase 1 chunked: error paths ────────────────────────────────────

describe("runSyncInit — error path", () => {
  beforeEach(resetAllMocks);

  it("marks run failed and fires error notification when fetchAosomCatalog throws", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    vi.mocked(fetchAosomCatalog).mockRejectedValueOnce(new Error("CSV fetch error"));

    await expect(runSyncInit()).rejects.toThrow("CSV fetch error");

    const calls = vi.mocked(db.completeSyncRun).mock.calls;
    expect(calls.some(([, args]) => args.status === "failed")).toBe(true);
    expect(db.createNotification).toHaveBeenCalledWith("error", "Sync init échouée", expect.stringContaining("CSV fetch error"));
    expect(blobStorage.savePhase1Blob).not.toHaveBeenCalled();
  });

  it("skips init if today's checkpoint already exists (not yet finalized — protects in-progress refresh)", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 2, chunksProcessed: 1,
      refreshDone: false, finalized: false,
      totalProducts: 5000, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });

    const result = await runSyncInit();

    expect(result.skipped).toBe(true);
    expect(db.createSyncRun).not.toHaveBeenCalled();
    expect(blobStorage.savePhase1Blob).not.toHaveBeenCalled();
  });
});

describe("runSyncRefreshChunk — error path", () => {
  beforeEach(resetAllMocks);

  it("marks run failed and rethrows when refreshProducts throws, does NOT advance chunksProcessed", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 1, chunksProcessed: 0,
      refreshDone: false, finalized: false,
      totalProducts: 50, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });
    vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({ toWriteMapped: Array(50).fill({ sku: "S1" }) as Phase1BlobProductRow[], priceChangeEntries: [] });
    vi.mocked(db.refreshProducts).mockRejectedValueOnce(new Error("DB timeout"));

    await expect(runSyncRefreshChunk()).rejects.toThrow("DB timeout");

    const calls = vi.mocked(db.completeSyncRun).mock.calls;
    expect(calls.some(([, args]) => args.status === "failed")).toBe(true);
    expect(db.savePhase1Checkpoint).not.toHaveBeenCalled();
  });

  it("skips when checkpoint is from yesterday", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: YESTERDAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 1, chunksProcessed: 0,
      refreshDone: false, finalized: false,
      totalProducts: 50, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });

    const result = await runSyncRefreshChunk();

    expect(result.skipped).toBe(true);
    expect(db.createSyncRun).not.toHaveBeenCalled();
  });
});

describe("runSyncFinalize — stale checkpoint", () => {
  beforeEach(resetAllMocks);

  it("skips when checkpoint is from yesterday", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: YESTERDAY, blobUrl: "",
      totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: false,
      totalProducts: 50, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    });

    const result = await runSyncFinalize();

    expect(result.skipped).toBe(true);
    expect(db.rebuildProductTypeCounts).not.toHaveBeenCalled();
  });
});

// ─── runSyncFull ──────────────────────────────────────────────────────

describe("runSyncFull — skips if already finalized today", () => {
  beforeEach(resetAllMocks);

  it("returns skipped=true without calling init/refresh/finalize", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "", totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: true,
      totalProducts: 100, priceUpdates: 5, stockChanges: 3, newProducts: 0,
    });

    const result = await runSyncFull();

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("Already finalized today");
    expect(result.totalProducts).toBe(100);
    expect(result.totalChunks).toBe(1);
    expect(db.createSyncRun).not.toHaveBeenCalled();
  });
});

describe("runSyncFull — fresh start (no checkpoint)", () => {
  beforeEach(resetAllMocks);

  it("runs init → 1 chunk → finalize and returns success", async () => {
    const mappedRows = Array.from({ length: 50 }, (_, i) => ({
      sku: `S${i}`, name: `P${i}`, price: 10, qty: 5, color: "", size: "", product_type: "Home",
      image1: "", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "",
      video: "", description: "", short_description: "", material: "", gtin: "", weight: 0,
      out_of_stock_expected: "", estimated_arrival: "", last_seen_at: 0,
    }));

    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    vi.mocked(fetchAosomCatalog).mockResolvedValue(
      mappedRows.map(r => ({
        sku: r.sku, name: r.name, price: r.price, qty: r.qty, color: r.color, size: r.size,
        shortDescription: "", description: "", images: [], gtin: "", weight: 0,
        dimensions: { length: 0, width: 0, height: 0 },
        productType: r.product_type, category: "", brand: "", material: "", psin: r.sku, sin: "",
        video: "", estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "", pdf: "",
      }))
    );

    // Init sets checkpoint with totalChunks=1, refreshDone=false
    vi.mocked(db.savePhase1Checkpoint).mockImplementation(async (cp) => {
      // After init saves: simulate checkpoint with chunksProcessed=0
      vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({ ...cp });
    });

    // After refresh chunk: checkpoint advances to chunksProcessed=1, refreshDone=true
    vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({ toWriteMapped: mappedRows, priceChangeEntries: [] });

    // After full savePhase1Checkpoint sequence, finalize will see refreshDone=true
    // We simulate the checkpoint progression via side effects on savePhase1Checkpoint
    vi.mocked(db.savePhase1Checkpoint).mockImplementation(async (cp) => {
      vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({ ...cp });
    });

    const result = await runSyncFull();

    expect(result.skipped).toBe(false);
    expect(result.totalProducts).toBe(50);
    expect(db.rebuildProductTypeCounts).toHaveBeenCalledOnce();
  });
});

describe("runSyncFull — resumes from partial checkpoint (chunks_done=2, totalChunks=3)", () => {
  beforeEach(resetAllMocks);

  it("skips init, processes remaining chunk, then finalizes", async () => {
    // Partial checkpoint: 2/3 chunks done
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "https://blob.test/run.json",
      totalChunks: 3, chunksProcessed: 2,
      refreshDone: false, finalized: false,
      totalProducts: 7500, priceUpdates: 100, stockChanges: 500, newProducts: 0,
    });

    // readPhase1Blob returns data for the remaining chunk
    vi.mocked(blobStorage.readPhase1Blob).mockResolvedValue({
      toWriteMapped: Array(2500).fill({ sku: "S1" }) as Phase1BlobProductRow[],
      priceChangeEntries: [],
    });

    // Simulate checkpoint advancing to refreshDone=true after chunk 3
    vi.mocked(db.savePhase1Checkpoint).mockImplementation(async (cp) => {
      vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({ ...cp });
    });

    const result = await runSyncFull();

    expect(result.skipped).toBe(false);
    // Init must NOT have called fetchAosomCatalog (existing checkpoint → skipped)
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    expect(fetchAosomCatalog).not.toHaveBeenCalled();
    // Exactly 1 refresh chunk written (chunk 3/3)
    expect(db.refreshProducts).toHaveBeenCalledOnce();
    // Finalize must have run
    expect(db.rebuildProductTypeCounts).toHaveBeenCalledOnce();
  });
});

describe("runSyncFull — idempotent (second call same day skips)", () => {
  beforeEach(resetAllMocks);

  it("second call returns skipped=true after first call finalized", async () => {
    // Simulate already finalized (e.g. retry slot at 06:30 after 06:00 succeeded)
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: TODAY, blobUrl: "", totalChunks: 1, chunksProcessed: 1,
      refreshDone: true, finalized: true,
      totalProducts: 200, priceUpdates: 0, stockChanges: 10, newProducts: 0,
    });

    const result = await runSyncFull();

    expect(result.skipped).toBe(true);
    expect(db.createSyncRun).not.toHaveBeenCalled();
    expect(db.refreshProducts).not.toHaveBeenCalled();
    expect(db.rebuildProductTypeCounts).not.toHaveBeenCalled();
  });
});

describe("runSyncFull — zero chunks (no catalog changes)", () => {
  beforeEach(resetAllMocks);

  it("skips refresh loop and goes straight to finalize when totalChunks=0", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    // Unchanged catalog → toWrite=[] → totalChunks=0, refreshDone=true.
    // Modelled with a real feed matching the snapshot: an EMPTY feed is a different
    // situation entirely and now throws, which is the whole point of the 2026-09-12 fix.
    const feed = makeUnchangedFeed(120);
    vi.mocked(fetchAosomCatalog).mockResolvedValue(feed.products);
    vi.mocked(db.getProductsSnapshot).mockResolvedValue(feed.snapshot as Awaited<ReturnType<typeof db.getProductsSnapshot>>);

    // After init saves checkpoint with refreshDone=true, finalize will see it
    vi.mocked(db.savePhase1Checkpoint).mockImplementation(async (cp) => {
      vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({ ...cp });
    });

    const result = await runSyncFull();

    expect(result.skipped).toBe(false);
    expect(result.totalChunks).toBe(0);
    expect(db.refreshProducts).not.toHaveBeenCalled();
    expect(db.rebuildProductTypeCounts).toHaveBeenCalledOnce();
  });
});

describe("runSyncFull — skips when lock is held (parallel call guard)", () => {
  beforeEach(resetAllMocks);

  it("returns skipped=true with reason='Another sync in progress' when lock not acquired", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue(null);
    vi.mocked(syncLock.tryAcquireSyncLock).mockResolvedValue(null);
    vi.mocked(syncLock.getSyncLockStatus).mockResolvedValue({
      holder: "cron-06-00",
      acquiredAt: Math.floor(Date.now() / 1000) - 30,
      ageSeconds: 30,
    });

    const result = await runSyncFull();

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("Another sync in progress");
    expect(result.lockHolder).toBe("cron-06-00");
    expect(result.lockAgeSeconds).toBe(30);
    expect(db.createSyncRun).not.toHaveBeenCalled();
    expect(db.rebuildProductTypeCounts).not.toHaveBeenCalled();
  });

  // ─── The 2026-09-12 mass-archive guards ─────────────────────────────
  //
  // Regression cover for the incident where a frozen CSV cache made Phase 1 see zero
  // changes, left products.last_seen_at un-stamped catalogue-wide, and let Phase 2 read
  // the empty "seen today" set as "Aosom withdrew everything" — drafting 30 live products
  // before it was caught. Both halves are locked: Phase 1 must refuse an implausible feed
  // without touching the good checkpoint, and Phase 2 must refuse a mass archive without
  // holding up the price and stock work in the same run.

  function makeShopifyProduct(id: string, status: "active" | "draft" = "active") {
    return {
      shopifyId: id, title: `Product ${id}`, status, bodyHtml: "<p>fr</p>", productType: "Test",
      images: [], tags: [],
      variants: [{ variantId: `V-${id}`, sku: `${id}-BK`, price: 10, inventoryQuantity: 5,
        inventoryItemId: `INV-${id}`, option1: null, option2: null, weight: 1, gtin: "" }],
    };
  }

  function makeAosomProduct(sku: string): AosomProduct {
    return {
      sku, name: `Produit ${sku}`, price: 10, qty: 5, color: "", size: "", productType: "Test",
      images: [], video: "", description: "", shortDescription: "", material: "", gtin: "",
      weight: 1, estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "",
      boxWeight: "", dimensions: { length: 1, width: 1, height: 1 },
      category: "Test", brand: "TestBrand", psin: "", sin: "", pdf: "",
    };
  }

  function makeArchiveDiff(id: string) {
    const d = makeProductDiff(id, "archive");
    d.shopifyId = id;
    d.changes = [{ field: "removed_product", sku: `${id}-BK`, oldValue: "t", newValue: null }] as unknown as typeof d.changes;
    return d;
  }

  it("Phase 1 refuses an empty feed and leaves the previous checkpoint untouched", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: YESTERDAY, blobUrl: "https://blob/yesterday.json", totalChunks: 4,
      chunksProcessed: 4, refreshDone: true, finalized: true, totalProducts: 8018,
      priceUpdates: 12, stockChanges: 30, newProducts: 2,
    } as Awaited<ReturnType<typeof db.getPhase1Checkpoint>>);
    vi.mocked(fetchAosomCatalog).mockResolvedValue([]);

    await expect(runSyncInit()).rejects.toThrow(/Refusing to sync/);

    // The single most important assertion here: yesterday's good state survives.
    expect(db.savePhase1Checkpoint).not.toHaveBeenCalled();
    // And the failure is visible, not swallowed into a "success".
    expect(db.completeSyncRun).toHaveBeenCalledWith("run-new", expect.objectContaining({ status: "failed" }));
    expect(db.createNotification).toHaveBeenCalledWith("error", expect.stringContaining("Sync init"), expect.any(String));
  });

  it("Phase 1 refuses a feed under half the last good run", async () => {
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: YESTERDAY, blobUrl: "", totalChunks: 0, chunksProcessed: 0, refreshDone: true,
      finalized: true, totalProducts: 8018, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    } as Awaited<ReturnType<typeof db.getPhase1Checkpoint>>);
    vi.mocked(fetchAosomCatalog).mockResolvedValue(
      Array.from({ length: 3000 }, (_, i) => makeAosomProduct(`SKU-${i}`))
    );

    await expect(runSyncInit()).rejects.toThrow(/under 50%/);
    expect(db.savePhase1Checkpoint).not.toHaveBeenCalled();
  });

  it("Phase 1 stamps last_seen_at for EVERY feed SKU, including on a zero-change day", async () => {
    // The actual defect: on 2026-09-12 the diff was empty, so nothing was written and no
    // SKU was marked as seen. Presence in the feed and having changed are different facts.
    const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
    const feed = Array.from({ length: 8018 }, (_, i) => makeAosomProduct(`SKU-${i}`));
    vi.mocked(fetchAosomCatalog).mockResolvedValue(feed);
    // Snapshot identical to the feed → diffProductsLight yields zero writes.
    vi.mocked(db.getProductsSnapshot).mockResolvedValue(new Map(
      feed.map((p) => [p.sku, {
        sku: p.sku, name: p.name, price: p.price, qty: p.qty, color: "", size: "",
        product_type: p.productType, image1: "", image2: "", image3: "", image4: "",
        image5: "", image6: "", image7: "", video: "", description: "", short_description: "",
        material: "", gtin: "", weight: p.weight, out_of_stock_expected: "", estimated_arrival: "",
      }])
    ) as Awaited<ReturnType<typeof db.getProductsSnapshot>>);

    const result = await runSyncInit();

    expect(result.totalChunks).toBe(0); // genuinely nothing to write — that part is fine
    expect(db.markSkusSeen).toHaveBeenCalledOnce();
    const [skusMarked] = vi.mocked(db.markSkusSeen).mock.calls[0];
    expect(skusMarked).toHaveLength(8018); // all of them, not just the changed ones
  });

  it("Phase 2 blocks 1,349 archives against 1,382 active but still applies the price diff", async () => {
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue(
      Array.from({ length: 1382 }, (_, i) => makeShopifyProduct(`P${i}`)) as Awaited<ReturnType<typeof shopifyClient.fetchAllShopifyProducts>>
    );

    const priceDiff = makeProductDiff("P0", "update");
    priceDiff.shopifyId = "P0";
    priceDiff.changes = [{ field: "price", sku: "P0-BK", oldValue: 10, newValue: 8 }] as unknown as typeof priceDiff.changes;
    const archiveDiffs = Array.from({ length: 1349 }, (_, i) => makeArchiveDiff(`P${i + 1}`));
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(
      [priceDiff, ...archiveDiffs] as ReturnType<typeof diffEngine.computeDiffs>
    );

    const res = await runShopifyPush();

    // Nothing was drafted.
    expect(shopifyClient.draftShopifyProduct).not.toHaveBeenCalled();
    expect(res.archived).toBe(0);
    // The operator is told, loudly.
    expect(db.createNotification).toHaveBeenCalledWith(
      "error", expect.stringContaining("Archivage de masse bloqué"), expect.any(String)
    );
    // Only the surviving diff is queued, so the checkpoint cannot "complete" the 1,349.
    const [saved] = vi.mocked(db.saveShopifyPushCheckpoint).mock.calls.at(-1)!;
    expect(saved.totalDiffs).toBe(1);
  });

  it("Phase 2 leaves a normal run alone — a handful of real removals still archive", async () => {
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue(
      Array.from({ length: 1382 }, (_, i) => makeShopifyProduct(`P${i}`)) as Awaited<ReturnType<typeof shopifyClient.fetchAllShopifyProducts>>
    );
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(
      Array.from({ length: 6 }, (_, i) => makeArchiveDiff(`P${i}`)) as ReturnType<typeof diffEngine.computeDiffs>
    );

    const res = await runShopifyPush();

    expect(shopifyClient.draftShopifyProduct).toHaveBeenCalledTimes(6);
    expect(res.archived).toBe(6);
    expect(db.createNotification).not.toHaveBeenCalledWith(
      "error", expect.stringContaining("Archivage de masse bloqué"), expect.any(String)
    );
  });
});

describe("runSyncFull — releases lock in finally block on error", () => {
  beforeEach(resetAllMocks);

  it("calls releaseSyncLock even when runSyncInit throws", async () => {
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue(null);
    vi.mocked(syncLock.tryAcquireSyncLock).mockResolvedValue("test-holder");
    vi.mocked(db.clearStaleLockIfNeeded).mockRejectedValue(new Error("DB timeout"));

    await expect(runSyncFull()).rejects.toThrow("DB timeout");

    expect(syncLock.releaseSyncLock).toHaveBeenCalledWith("test-holder");
  });
});

// ─── Architectural boundary: the Shopify push never writes body_html ──
//
// Regression guard for the 2026-04-05 → 2026-09-11 bug (b497260). The Aosom feed
// description is raw ENGLISH; the Shopify body_html is the curated FRENCH text
// written once by createShopifyProduct at import. diff-engine no longer emits a
// "description" change, and applyToShopify must not write bodyHtml even if one
// somehow reaches it again. At its peak this pushed English over French on
// 679 of 1382 active products (49%), 518 of them leaking the supplier name.
describe("runShopifyPush — never overwrites the authored description", () => {
  beforeEach(resetAllMocks);

  function descDiff(groupKey: string) {
    return {
      shopifyId: "shop-" + groupKey,
      groupKey,
      productName: "Product " + groupKey,
      action: "update" as const,
      // A *feed* description change, exactly as the old diff-engine emitted it.
      changes: [
        { field: "description", sku: groupKey + "-BK", oldValue: "<p>Texte français rédigé</p>", newValue: "<p>Raw English feed copy</p>" },
      ] as FieldChange[],
      aosomProduct: {
        groupKey,
        name: "Product " + groupKey,
        brand: "Aosom",
        productType: "Test",
        category: "Test",
        description: "<p>Raw English feed copy from Aosom</p>",
        shortDescription: "Short",
        material: "Metal",
        images: ["https://img.com/1.jpg"],
        video: "",
        pdf: "",
        variants: [] as AosomMergedProduct["variants"],
      },
    };
  }

  it("does not call updateShopifyProduct at all for a description-only diff", async () => {
    vi.mocked(diffEngine.computeDiffs).mockReturnValue([descDiff("G1")] as ReturnType<typeof diffEngine.computeDiffs>);

    await runShopifyPush();

    expect(shopifyClient.updateShopifyProduct).not.toHaveBeenCalled();
  });

  it("never passes bodyHtml to updateShopifyProduct, even when an image change also fires", async () => {
    const diff = descDiff("G2");
    diff.changes.push({ field: "images", sku: "G2-BK", oldValue: "1 images", newValue: "2 images" });
    vi.mocked(diffEngine.computeDiffs).mockReturnValue([diff] as ReturnType<typeof diffEngine.computeDiffs>);

    await runShopifyPush();

    // The image change is still pushed — that is feed-authoritative data.
    expect(shopifyClient.updateShopifyProduct).toHaveBeenCalledOnce();
    const [, updates] = vi.mocked(shopifyClient.updateShopifyProduct).mock.calls[0];
    expect(updates).toHaveProperty("images");
    // But the authored description is untouched.
    expect(updates).not.toHaveProperty("bodyHtml");
    expect(JSON.stringify(updates)).not.toContain("Raw English feed copy");
  });

  // productUpdates is assembled field-by-field with independent `if` branches, so
  // proving the images branch safe does not prove the tags branch safe. Cover the
  // other field that can legitimately travel in the same payload.
  it("never passes bodyHtml when a tags change travels in the same payload", async () => {
    const diff = descDiff("G3");
    diff.changes.push({ field: "tags", sku: "G3-BK", oldValue: "out-of-stock", newValue: "back-in-stock" });
    diff.aosomProduct.variants = [
      { sku: "G3-BK", price: 99.99, qty: 12, color: "Noir", size: "", gtin: "", weight: 5,
        dimensions: { length: 1, width: 1, height: 1 }, images: [], estimatedArrival: "",
        outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "" },
    ];
    vi.mocked(diffEngine.computeDiffs).mockReturnValue([diff] as ReturnType<typeof diffEngine.computeDiffs>);
    // applyToShopify's tags branch is gated on shopifyMap.get(diff.shopifyId); with the
    // default empty fetchAllShopifyProducts mock the branch never fires and this test
    // would pass vacuously. Give it the matching Shopify product so the branch executes.
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue([
      {
        shopifyId: "shop-G3", title: "Product G3", status: "active",
        bodyHtml: "<p>Le texte français rédigé à l'import</p>", productType: "Test",
        images: [], tags: ["out-of-stock"],
        variants: [{ variantId: "V-G3", sku: "G3-BK", price: 99.99, inventoryQuantity: 9,
          inventoryItemId: "INV-G3", option1: "Noir", option2: null, weight: 5, gtin: "" }],
      },
    ] as Awaited<ReturnType<typeof shopifyClient.fetchAllShopifyProducts>>);

    await runShopifyPush();

    // The branch really ran: tags were pushed.
    expect(shopifyClient.updateShopifyProduct).toHaveBeenCalledOnce();
    const [, updates] = vi.mocked(shopifyClient.updateShopifyProduct).mock.calls[0];
    expect(updates).toHaveProperty("tags");
    // And the authored description still never travels with it.
    expect(updates).not.toHaveProperty("bodyHtml");
    expect(JSON.stringify(updates)).not.toContain("Raw English feed copy");
  });
});

// ─── Scenario 8: the MANUAL trigger gets the same guards ──────────────
//
// v0.5.92.5 guarded the cron path (runSyncFull / runShopifyPush) but left runSync — the
// dashboard trigger behind POST /api/sync/trigger — wide open, and it was strictly MORE
// dangerous than the cron it mirrors: no plausibility check, no last_seen_at stamp, no
// archive breaker, and no chunk cap, so it applied EVERY diff in one pass instead of 10.
// On the 2026-09-12 feed it would have drafted the entire catalogue in a single run.
// These tests reproduce that incident through the manual trigger.

describe("runSync — manual trigger carries the same guards as the cron", () => {
  beforeEach(resetAllMocks);

  const activeStore = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      shopifyId: `P${i}`, title: `Product P${i}`, status: "active" as const,
      bodyHtml: "<p>fr</p>", productType: "Test", images: [], tags: [],
      variants: [{ variantId: `V-P${i}`, sku: `P${i}-BK`, price: 10, inventoryQuantity: 5,
        inventoryItemId: `INV-P${i}`, option1: null, option2: null, weight: 1, gtin: "" }],
    }));

  const archiveDiff = (id: string) => {
    const d = makeProductDiff(id, "archive");
    d.shopifyId = id;
    d.changes = [{ field: "removed_product", sku: `${id}-BK`, oldValue: "t", newValue: null }] as unknown as typeof d.changes;
    return d;
  };

  /**
   * A tags diff, the one non-archive branch of applyToShopify that is fully exercisable
   * under these mocks (the price branch goes through writePriceVerified → fetchVariant,
   * which is not mocked here). Shape copied from the PR #464 tags test, which proved the
   * branch really fires rather than passing vacuously.
   */
  const tagsDiff = (id: string) => {
    const d = makeProductDiff(id, "update");
    d.shopifyId = id;
    d.changes = [{ field: "tags", sku: `${id}-BK`, oldValue: "out-of-stock", newValue: "back-in-stock" }] as unknown as typeof d.changes;
    d.aosomProduct = {
      ...makeUnchangedFeed(1).products[0],
      sku: id,
      variants: [{ sku: `${id}-BK`, price: 10, qty: 12, color: "", size: "", gtin: "", weight: 1,
        dimensions: { length: 1, width: 1, height: 1 }, images: [], estimatedArrival: "",
        outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "" }],
    } as unknown as typeof d.aosomProduct;
    return d;
  };

  it("blocks the 2026-09-12 mass archive when driven through the manual trigger", async () => {
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue(
      activeStore(1382).map((p) => ({ ...p, tags: ["out-of-stock"] })) as Awaited<ReturnType<typeof shopifyClient.fetchAllShopifyProducts>>
    );
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(
      [tagsDiff("P0"), ...Array.from({ length: 1349 }, (_, i) => archiveDiff(`P${i + 1}`))] as ReturnType<typeof diffEngine.computeDiffs>
    );

    const result = await runSync({ shopifyPush: true });

    // Nothing drafted — the assertion that was impossible to satisfy before this change.
    expect(shopifyClient.draftShopifyProduct).not.toHaveBeenCalled();
    expect(result.archived).toBe(0);
    expect(result.archivesBlocked).toBe(1349);
    expect(db.createNotification).toHaveBeenCalledWith(
      "error", expect.stringContaining("Archivage de masse bloqué"), expect.any(String)
    );
    // The legitimate non-archive diff still applied in the very same run.
    expect(shopifyClient.updateShopifyProduct).toHaveBeenCalledOnce();
    expect(vi.mocked(shopifyClient.updateShopifyProduct).mock.calls[0][1]).toHaveProperty("tags");
  });

  it("caps the push at SHOPIFY_PUSH_CHUNK_SIZE instead of applying every diff at once", async () => {
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue(
      activeStore(1382) as Awaited<ReturnType<typeof shopifyClient.fetchAllShopifyProducts>>
    );
    // 40 archives — under the ceiling of 69, so the archive guard stays quiet and the
    // cap is the only thing limiting the run. Before this change all 40 would have been
    // drafted in one pass; the cron doing the same work does 10.
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(
      Array.from({ length: 40 }, (_, i) => archiveDiff(`P${i}`)) as ReturnType<typeof diffEngine.computeDiffs>
    );

    const result = await runSync({ shopifyPush: true });

    expect(result.archivesBlocked).toBe(0);
    expect(result.pushDeferred).toBe(30); // 40 − 10
    expect(shopifyClient.draftShopifyProduct).toHaveBeenCalledTimes(10);
    expect(result.archived).toBe(10);
  });

  it("still archives a normal handful of real removals", async () => {
    vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue(
      activeStore(1382) as Awaited<ReturnType<typeof shopifyClient.fetchAllShopifyProducts>>
    );
    vi.mocked(diffEngine.computeDiffs).mockReturnValue(
      Array.from({ length: 6 }, (_, i) => archiveDiff(`P${i}`)) as ReturnType<typeof diffEngine.computeDiffs>
    );

    const result = await runSync({ shopifyPush: true });

    expect(shopifyClient.draftShopifyProduct).toHaveBeenCalledTimes(6);
    expect(result.archived).toBe(6);
    expect(result.archivesBlocked).toBe(0);
    expect(result.pushDeferred).toBe(0);
    expect(db.createNotification).not.toHaveBeenCalledWith(
      "error", expect.stringContaining("Archivage de masse bloqué"), expect.any(String)
    );
  });

  it("refuses an empty feed before writing anything at all", async () => {
    vi.mocked(csvFetcher.fetchAosomCatalog).mockResolvedValue([]);
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: YESTERDAY, blobUrl: "", totalChunks: 4, chunksProcessed: 4, refreshDone: true,
      finalized: true, totalProducts: 8018, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    } as Awaited<ReturnType<typeof db.getPhase1Checkpoint>>);

    await expect(runSync({ shopifyPush: true })).rejects.toThrow(/came back empty/);

    // No DB write, no Shopify write — the guard sits ahead of all of them.
    expect(db.refreshProducts).not.toHaveBeenCalled();
    expect(db.markSkusSeen).not.toHaveBeenCalled();
    expect(shopifyClient.draftShopifyProduct).not.toHaveBeenCalled();
    expect(shopifyClient.updateShopifyVariantPrice).not.toHaveBeenCalled();
    expect(db.completeSyncRun).toHaveBeenCalledWith("run-new", expect.objectContaining({ status: "failed" }));
  });

  it("refuses a feed under half the last good Phase 1 run", async () => {
    vi.mocked(csvFetcher.fetchAosomCatalog).mockResolvedValue(makeUnchangedFeed(3000).products);
    vi.mocked(db.getPhase1Checkpoint).mockResolvedValue({
      date: YESTERDAY, blobUrl: "", totalChunks: 4, chunksProcessed: 4, refreshDone: true,
      finalized: true, totalProducts: 8018, priceUpdates: 0, stockChanges: 0, newProducts: 0,
    } as Awaited<ReturnType<typeof db.getPhase1Checkpoint>>);

    await expect(runSync({ shopifyPush: true })).rejects.toThrow(/under 50%/);
    expect(db.refreshProducts).not.toHaveBeenCalled();
    expect(db.markSkusSeen).not.toHaveBeenCalled();
  });

  it("stamps last_seen_at for every feed SKU on a quiet day", async () => {
    // The manual trigger has to record presence too, or it reproduces the exact hole the
    // cron had: a quiet day leaving an empty "seen today" set for the next Phase 2.
    const feed = makeUnchangedFeed(500);
    vi.mocked(csvFetcher.fetchAosomCatalog).mockResolvedValue(feed.products);
    vi.mocked(db.getProductsSnapshot).mockResolvedValue(feed.snapshot as Awaited<ReturnType<typeof db.getProductsSnapshot>>);

    await runSync({ shopifyPush: false });

    expect(db.refreshProducts).not.toHaveBeenCalled(); // nothing changed
    expect(db.markSkusSeen).toHaveBeenCalledOnce();     // but everything was seen
    expect(vi.mocked(db.markSkusSeen).mock.calls[0][0]).toHaveLength(500);
  });

  it("never stamps last_seen_at on a dry run", async () => {
    await runSync({ dryRun: true });

    expect(db.markSkusSeen).not.toHaveBeenCalled();
    expect(db.refreshProducts).not.toHaveBeenCalled();
  });
});
