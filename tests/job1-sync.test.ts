/**
 * Tests for job1-sync.ts — guard rails, chunking, checkpoint resume.
 *
 * Covers 6 scenarios:
 * 1. runSync completes normally → status="completed"
 * 2. runSync throws mid-flight → catch marks status="failed" (never "running")
 * 3. runSync with stale "running" run → clearStaleLockIfNeeded called, new run created
 * 4. runShopifyPush with valid today checkpoint → resumes from processedGroupKeys
 * 5. runShopifyPush with expired checkpoint (yesterday) → ignores checkpoint, starts fresh
 * 6. GET /api/sync/health → correct shape for all scenarios
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  addSyncLogsBatch: vi.fn().mockResolvedValue(undefined),
  refreshProducts: vi.fn().mockResolvedValue(undefined),
  rebuildProductTypeCounts: vi.fn().mockResolvedValue(undefined),
  recordPriceChanges: vi.fn().mockResolvedValue(undefined),
  getProduct: vi.fn().mockResolvedValue(null),
  getProductsSnapshot: vi.fn().mockResolvedValue(new Map()),
  getSetting: vi.fn().mockResolvedValue(null),
  createNotification: vi.fn().mockResolvedValue(1),
  getAllProductsAsAosom: vi.fn().mockResolvedValue([]),
  getShopifyPushCheckpoint: vi.fn().mockResolvedValue(null),
  saveShopifyPushCheckpoint: vi.fn().mockResolvedValue(undefined),
  getSyncRuns: vi.fn().mockResolvedValue([]),
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
}));

vi.mock("@/lib/config", () => ({
  env: { shopifyAccessToken: "test", hasShopifyToken: true, anthropicApiKey: "test", cronSecret: "test" },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  SYNC: { MAX_PRODUCTS: 10000, PRICE_CHANGE_NOTIFICATION_THRESHOLD: 5 },
  CLAUDE: { MODEL: "claude-sonnet-4-20250514", MAX_TOKENS_CONTENT: 2048 },
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
const { runSync, runShopifyPush } = await import("@/jobs/job1-sync");
const { GET } = await import("@/app/api/sync/health/route");

// ─── Test utilities ───────────────────────────────────────────────────

function resetAllMocks() {
  vi.clearAllMocks(); // reset call counts between tests
  vi.mocked(db.clearStaleLockIfNeeded).mockResolvedValue(undefined);
  vi.mocked(db.getLatestSyncRun).mockResolvedValue(null);
  vi.mocked(db.createSyncRun).mockResolvedValue({ id: "run-new", startedAt: new Date().toISOString() } as ReturnType<typeof db.createSyncRun> extends Promise<infer T> ? T : never);
  vi.mocked(db.completeSyncRun).mockResolvedValue(undefined);
  vi.mocked(db.addSyncLogsBatch).mockResolvedValue(undefined);
  vi.mocked(db.refreshProducts).mockResolvedValue(undefined);
  vi.mocked(db.rebuildProductTypeCounts).mockResolvedValue(undefined);
  vi.mocked(db.recordPriceChanges).mockResolvedValue(undefined);
  vi.mocked(db.createNotification).mockResolvedValue(1);
  vi.mocked(db.getAllProductsAsAosom).mockResolvedValue([]);
  vi.mocked(db.getProductsSnapshot).mockResolvedValue(new Map());
  vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue(null);
  vi.mocked(db.saveShopifyPushCheckpoint).mockResolvedValue(undefined);
  vi.mocked(shopifyClient.fetchAllShopifyProducts).mockResolvedValue([]);
  vi.mocked(diffEngine.computeDiffs).mockReturnValue([]);
  vi.mocked(diffEngine.summarizeDiffs).mockReturnValue({ total: 0, updates: 0, archives: 0, creates: 0, priceChanges: 0, stockChanges: 0, imageChanges: 0, descriptionChanges: 0 });
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
      makeSyncRun({ id: "run-stuck", status: "running", completedAt: null }) as any
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

// ─── Scenario 6: GET /api/sync/health ────────────────────────────────

describe("GET /api/sync/health", () => {
  beforeEach(resetAllMocks);

  it("returns null phase1 when no runs today", async () => {
    vi.mocked(db.getSyncRuns).mockResolvedValue([]);
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.phase1).toBeNull();
    expect(body.data.zombies).toHaveLength(0);
  });

  it("returns phase1 from the run that does NOT have the Phase2-only marker", async () => {
    const phase1Run = makeSyncRun({ id: "run-phase1", errorMessages: [] });
    const phase2Run = makeSyncRun({
      id: "run-phase2",
      errorMessages: ["DB sync only — Shopify push deferred"],
    });
    vi.mocked(db.getSyncRuns).mockResolvedValue([phase1Run, phase2Run] as any);

    const res = await GET();
    const body = await res.json();

    expect(body.data.phase1.id).toBe("run-phase1");
  });

  it("returns phase2 checkpoint data when checkpoint is from today", async () => {
    vi.mocked(db.getSyncRuns).mockResolvedValue([]);
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: TODAY,
      processedGroupKeys: ["gk-1", "gk-2"],
      totalDiffs: 5,
      totalUpdates: 2,
      totalArchived: 0,
      totalErrors: 0,
      done: false,
    });

    const res = await GET();
    const body = await res.json();

    expect(body.data.phase2.processedDiffs).toBe(2);
    expect(body.data.phase2.totalDiffs).toBe(5);
    expect(body.data.phase2.done).toBe(false);
  });

  it("returns zeroed phase2 when checkpoint is from yesterday", async () => {
    vi.mocked(db.getSyncRuns).mockResolvedValue([]);
    vi.mocked(db.getShopifyPushCheckpoint).mockResolvedValue({
      date: YESTERDAY,
      processedGroupKeys: ["gk-1"],
      totalDiffs: 3,
      totalUpdates: 1,
      totalArchived: 0,
      totalErrors: 0,
      done: true,
    });

    const res = await GET();
    const body = await res.json();

    expect(body.data.phase2.processedDiffs).toBe(0);
    expect(body.data.phase2.totalDiffs).toBe(0);
    expect(body.data.phase2.done).toBe(false);
  });

  it("lists zombie runs (status=running)", async () => {
    const zombie = makeSyncRun({ id: "run-zombie", status: "running", completedAt: null });
    vi.mocked(db.getSyncRuns).mockResolvedValue([zombie] as any);

    const res = await GET();
    const body = await res.json();

    expect(body.data.zombies).toHaveLength(1);
    expect(body.data.zombies[0].id).toBe("run-zombie");
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(db.getSyncRuns).mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
  });
});

// ─── Scenario 7: runSync — dryRun=true ───────────────────────────────

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

    // Snapshot matches exactly — price, qty, images all the same
    vi.mocked(db.getProductsSnapshot).mockResolvedValueOnce(new Map([
      ["SKU-SAME", {
        sku: "SKU-SAME", price: 99.99, qty: 5,
        image1: "img.jpg", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "",
        out_of_stock_expected: "", estimated_arrival: "", shopify_product_id: null,
      }],
    ]));

    await runSync({ shopifyPush: false });

    // Nothing changed → refreshProducts should NOT be called
    expect(db.refreshProducts).not.toHaveBeenCalled();
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
      ["SKU-OLD", { sku: "SKU-OLD", price: 50.00, qty: 3, image1: "", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "", out_of_stock_expected: "", estimated_arrival: "", shopify_product_id: null }],
      ["SKU-NEW-PRICE", { sku: "SKU-NEW-PRICE", price: 99.99, qty: 3, image1: "", image2: "", image3: "", image4: "", image5: "", image6: "", image7: "", out_of_stock_expected: "", estimated_arrival: "", shopify_product_id: null }],
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
