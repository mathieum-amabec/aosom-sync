import { describe, it, expect, vi } from "vitest";
import {
  runPriceReconcile,
  runPostSyncSample,
  MAX_CORRECTIONS_PER_RECONCILE,
  advanceReconcileCheckpoint,
  formatSweepCompleteAlert,
} from "@/lib/price-reconcile";
import type { PriceReconcileCheckpoint } from "@/lib/database";

const noSleep = async () => {};

/** A reconcile harness whose Shopify side actually stores what is written. */
function harness(opts: {
  expected: Record<string, number>;
  shopify: Array<{ sku: string; price: number; variantId: string }>;
  failFor?: string[];
}) {
  const store = new Map(opts.shopify.map((v) => [v.variantId, v.price]));
  const writes: Array<{ variantId: string; price: number; at: number }> = [];
  let seq = 0;
  const notify = vi.fn().mockResolvedValue(1);
  return {
    store,
    writes,
    notify,
    deps: {
      loadExpectedPrices: async () => new Map(Object.entries(opts.expected)),
      loadShopifyVariants: async () => opts.shopify,
      writePrice: async (variantId: string, price: number) => {
        writes.push({ variantId, price, at: seq++ });
        // A variant in failFor accepts the PUT but never stores the value.
        if (!opts.failFor?.includes(variantId)) store.set(variantId, price);
      },
      readVariant: async (variantId: string) =>
        store.has(variantId) ? { price: store.get(variantId)! } : null,
      notify,
      sleep: noSleep,
    },
  };
}

describe("LAYER 2 — runPriceReconcile", () => {
  it("corrects drift in BOTH directions and leaves matching prices alone", async () => {
    const h = harness({
      expected: { A: 135.99, B: 104.99, C: 50 },
      shopify: [
        { sku: "A", price: 119.99, variantId: "vA" }, // 16$ too cheap
        { sku: "B", price: 109.99, variantId: "vB" }, // 5$ too dear
        { sku: "C", price: 50, variantId: "vC" }, // correct
      ],
    });
    const r = await runPriceReconcile(h.deps);
    expect(r).toMatchObject({ scanned: 3, drifted: 2, corrected: 2, failed: 0, deferred: 0 });
    expect(h.store.get("vA")).toBe(135.99);
    expect(h.store.get("vB")).toBe(104.99);
    expect(h.writes.map((w) => w.variantId)).not.toContain("vC");
  });

  it("fixes the price DROP direction the floor audit can never touch", async () => {
    // /api/health/price-audit only pushes prices UP to the Aosom floor. A supplier drop
    // leaves us more expensive than Aosom forever. This is the regression test for that.
    const h = harness({ expected: { B: 104.99 }, shopify: [{ sku: "B", price: 109.99, variantId: "vB" }] });
    const r = await runPriceReconcile(h.deps);
    expect(r.corrected).toBe(1);
    expect(h.store.get("vB")).toBe(104.99);
  });

  it("writes SEQUENTIALLY — no two variants of a product race each other (faille C)", async () => {
    const h = harness({
      expected: { A: 10, B: 20, C: 30 },
      shopify: [
        { sku: "A", price: 1, variantId: "vA" },
        { sku: "B", price: 2, variantId: "vB" },
        { sku: "C", price: 3, variantId: "vC" },
      ],
    });
    await runPriceReconcile(h.deps);
    // Monotonic sequence numbers prove the writes did not interleave.
    expect(h.writes.map((w) => w.at)).toEqual([0, 1, 2]);
  });

  it("notifies when a write cannot be verified, and does not count it as corrected", async () => {
    const h = harness({
      expected: { A: 135.99 },
      shopify: [{ sku: "A", price: 119.99, variantId: "vA" }],
      failFor: ["vA"],
    });
    const r = await runPriceReconcile(h.deps);
    expect(r).toMatchObject({ corrected: 0, failed: 1 });
    expect(h.notify).toHaveBeenCalledWith("price_write_failed", expect.stringContaining("1 variante(s)"), expect.stringContaining("A"));
  });

  it("caps corrections per run and notifies about the deferred remainder", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ sku: `S${i}`, price: 1, variantId: `v${i}` }));
    const expected = Object.fromEntries(many.map((v) => [v.sku, 99]));
    const h = harness({ expected, shopify: many });
    const r = await runPriceReconcile({ ...h.deps, maxCorrections: 2 });
    expect(r).toMatchObject({ drifted: 5, corrected: 2, deferred: 3 });
    expect(h.writes).toHaveLength(2);
    expect(h.notify).toHaveBeenCalledWith("price_drift", expect.stringContaining("3 variante(s)"), expect.any(String));
  });

  it("stays quiet when nothing drifted", async () => {
    const h = harness({ expected: { A: 10 }, shopify: [{ sku: "A", price: 10, variantId: "vA" }] });
    const r = await runPriceReconcile(h.deps);
    expect(r).toMatchObject({ drifted: 0, corrected: 0 });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("has a per-run cap sized to fit the route's maxDuration", () => {
    // 300 corrections x (1 write + 1 read) at ~2 req/s is ~5 min; the route allows 300s.
    expect(MAX_CORRECTIONS_PER_RECONCILE).toBe(300);
  });
});

describe("LAYER 4 — runPostSyncSample", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, price: 10, variantId: `v${i}`, inventoryQuantity: 5 }));

  it("samples at most sampleSize and reports no drift when everything matches", async () => {
    const variants = mk(200);
    const expected = new Map(variants.map((v) => [v.sku, { price: 10, qty: 5 }]));
    const notify = vi.fn();
    const r = await runPostSyncSample({
      loadExpected: async () => expected,
      loadShopifyVariants: async () => variants,
      notify,
      sampleSize: 50,
    });
    expect(r.sampled).toBe(50);
    expect(r.priceDrift).toEqual([]);
    expect(r.stockDrift).toEqual([]);
    expect(r.alerted).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("catches inventory drift — the thing layer 2 cannot see", async () => {
    const variants = [{ sku: "A", price: 10, variantId: "vA", inventoryQuantity: 0 }];
    const notify = vi.fn().mockResolvedValue(1);
    const r = await runPostSyncSample({
      loadExpected: async () => new Map([["A", { price: 10, qty: 17 }]]),
      loadShopifyVariants: async () => variants,
      notify,
    });
    expect(r.priceDrift).toEqual([]);
    expect(r.stockDrift).toEqual([{ sku: "A", shopifyQty: 0, expectedQty: 17 }]);
    expect(r.alerted).toBe(true);
    expect(notify).toHaveBeenCalledWith("post_sync_sample", expect.stringContaining("1 écart"), expect.stringContaining("INVENTAIRE"));
  });

  it("catches price drift in the sample too", async () => {
    const notify = vi.fn().mockResolvedValue(1);
    const r = await runPostSyncSample({
      loadExpected: async () => new Map([["A", { price: 135.99, qty: 5 }]]),
      loadShopifyVariants: async () => [{ sku: "A", price: 119.99, variantId: "vA", inventoryQuantity: 5 }],
      notify,
    });
    expect(r.priceDrift[0]).toMatchObject({ sku: "A", gap: -16 });
    expect(notify).toHaveBeenCalled();
  });

  it("only compares SKUs present on BOTH sides", async () => {
    const notify = vi.fn();
    const r = await runPostSyncSample({
      loadExpected: async () => new Map([["KNOWN", { price: 10, qty: 1 }]]),
      loadShopifyVariants: async () => [
        { sku: "KNOWN", price: 10, variantId: "v1", inventoryQuantity: 1 },
        { sku: "MANUAL", price: 999, variantId: "v2", inventoryQuantity: 0 },
      ],
      notify,
    });
    expect(r.sampled).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("LOG DÉTAILLÉ — traçabilité sync_logs", () => {
  function loggingHarness(opts: { expected: Record<string, number>; shopify: Array<{ sku: string; price: number; variantId: string; shopifyProductId?: string }>; failFor?: string[] }) {
    const store = new Map(opts.shopify.map((v) => [v.variantId, v.price]));
    const logged: Array<{ runId: string; entries: unknown[] }> = [];
    return {
      logged,
      deps: {
        loadExpectedPrices: async () => new Map(Object.entries(opts.expected)),
        loadShopifyVariants: async () => opts.shopify,
        writePrice: async (variantId: string, price: number) => {
          if (!opts.failFor?.includes(variantId)) store.set(variantId, price);
        },
        readVariant: async (variantId: string) => (store.has(variantId) ? { price: store.get(variantId)! } : null),
        notify: vi.fn().mockResolvedValue(1),
        recordCorrections: async (runId: string, entries: unknown[]) => {
          logged.push({ runId, entries });
          return entries.length;
        },
        sleep: noSleep,
      },
    };
  }

  it("writes one row per APPLIED correction, with SKU, both prices and the reason", async () => {
    const h = loggingHarness({
      expected: { A: 135.99, B: 104.99 },
      shopify: [
        { sku: "A", price: 119.99, variantId: "vA", shopifyProductId: "p1" },
        { sku: "B", price: 109.99, variantId: "vB", shopifyProductId: "p1" },
      ],
    });
    const r = await runPriceReconcile(h.deps);
    expect(r.logged).toBe(2);
    expect(r.corrections).toEqual([
      { sku: "A", shopifyProductId: "p1", oldPriceShopify: 119.99, newPriceTurso: 135.99, reason: "reconciliation" },
      { sku: "B", shopifyProductId: "p1", oldPriceShopify: 109.99, newPriceTurso: 104.99, reason: "reconciliation" },
    ]);
  });

  it("groups every correction of a pass under ONE runId", async () => {
    const h = loggingHarness({
      expected: { A: 10, B: 20 },
      shopify: [{ sku: "A", price: 1, variantId: "vA" }, { sku: "B", price: 2, variantId: "vB" }],
    });
    const r = await runPriceReconcile(h.deps);
    expect(h.logged).toHaveLength(1); // one batched write
    expect(h.logged[0].runId).toBe(r.runId);
    expect(r.runId).toMatch(/^reconcile-\d{4}-\d{2}-\d{2}T/);
  });

  it("does NOT log a write that failed — a row claiming a price is live would be a lie", async () => {
    const h = loggingHarness({
      expected: { A: 135.99, B: 104.99 },
      shopify: [{ sku: "A", price: 119.99, variantId: "vA" }, { sku: "B", price: 109.99, variantId: "vB" }],
      failFor: ["vA"],
    });
    const r = await runPriceReconcile(h.deps);
    expect(r.corrected).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.corrections.map((c) => c.sku)).toEqual(["B"]);
    expect(r.logged).toBe(1);
  });

  it("writes nothing when nothing drifted", async () => {
    const h = loggingHarness({ expected: { A: 10 }, shopify: [{ sku: "A", price: 10, variantId: "vA" }] });
    const r = await runPriceReconcile(h.deps);
    expect(r.logged).toBe(0);
    expect(h.logged).toHaveLength(0);
  });

  it("survives a logging failure — prices are already live, the trail is secondary", async () => {
    const h = loggingHarness({ expected: { A: 135.99 }, shopify: [{ sku: "A", price: 119.99, variantId: "vA" }] });
    const r = await runPriceReconcile({ ...h.deps, recordCorrections: async () => { throw new Error("turso down"); } });
    expect(r.corrected).toBe(1); // the price IS live
    expect(r.logged).toBe(0); // the trail is not
  });

  it("still reconciles when no logger is injected at all", async () => {
    const h = loggingHarness({ expected: { A: 135.99 }, shopify: [{ sku: "A", price: 119.99, variantId: "vA" }] });
    const r = await runPriceReconcile({ ...h.deps, recordCorrections: undefined });
    expect(r.corrected).toBe(1);
    expect(r.logged).toBe(0);
  });
});

// ─── LAYER 2 rotation — TASK 2 ──────────────────────────────────────────────
//
// Whole-catalog coverage without an all-in-one-fetch: the route now processes one
// Shopify page per hourly run and resumes from where it left off. These tests cover
// the pure checkpoint bookkeeping only — runPriceReconcile itself is unchanged and
// already covered above, since it never cared whether its variant list was the
// whole catalog or a single page.
describe("advanceReconcileCheckpoint (rotation bookkeeping)", () => {
  const NOW = 1_790_000_000;

  it("starts a fresh sweep from a null checkpoint and advances to the next page", () => {
    const { checkpoint, completedSweep } = advanceReconcileCheckpoint(
      null,
      { nextPageInfo: "page2cursor", scanned: 250, drifted: 3, corrected: 3 },
      NOW,
    );
    expect(completedSweep).toBeNull();
    expect(checkpoint).toEqual<PriceReconcileCheckpoint>({
      pageInfo: "page2cursor",
      sweepNumber: 0,
      sweepStartedAt: NOW,
      pagesThisSweep: 1,
      variantsScannedThisSweep: 250,
      driftThisSweep: 3,
      correctedThisSweep: 3,
      lastSweepCompletedAt: null,
    });
  });

  it("accumulates running totals across pages within the same sweep", () => {
    const midSweep: PriceReconcileCheckpoint = {
      pageInfo: "page2cursor", sweepNumber: 0, sweepStartedAt: NOW - 3600,
      pagesThisSweep: 1, variantsScannedThisSweep: 250, driftThisSweep: 3, correctedThisSweep: 3,
      lastSweepCompletedAt: null,
    };
    const { checkpoint, completedSweep } = advanceReconcileCheckpoint(
      midSweep,
      { nextPageInfo: "page3cursor", scanned: 250, drifted: 1, corrected: 1 },
      NOW,
    );
    expect(completedSweep).toBeNull();
    expect(checkpoint).toMatchObject({
      pageInfo: "page3cursor",
      pagesThisSweep: 2,
      variantsScannedThisSweep: 500,
      driftThisSweep: 4,
      correctedThisSweep: 4,
      sweepStartedAt: NOW - 3600, // unchanged — the sweep didn't restart
    });
  });

  it("completes the sweep on the last page (nextPageInfo null), reports totals, and wraps to a fresh one", () => {
    const lastPage: PriceReconcileCheckpoint = {
      pageInfo: "page12cursor", sweepNumber: 4, sweepStartedAt: NOW - 40_000,
      pagesThisSweep: 11, variantsScannedThisSweep: 2750, driftThisSweep: 6, correctedThisSweep: 5,
      lastSweepCompletedAt: NOW - 200_000,
    };
    const { checkpoint, completedSweep } = advanceReconcileCheckpoint(
      lastPage,
      { nextPageInfo: null, scanned: 60, drifted: 0, corrected: 0 },
      NOW,
    );
    expect(completedSweep).toEqual({
      sweepNumber: 5, startedAt: NOW - 40_000, completedAt: NOW,
      pages: 12, variantsScanned: 2810, totalDrift: 6, totalCorrected: 5,
    });
    // Fresh sweep: cursor and running totals reset, sweepNumber carried forward.
    expect(checkpoint).toEqual<PriceReconcileCheckpoint>({
      pageInfo: null, sweepNumber: 5, sweepStartedAt: NOW,
      pagesThisSweep: 0, variantsScannedThisSweep: 0, driftThisSweep: 0, correctedThisSweep: 0,
      lastSweepCompletedAt: NOW,
    });
  });

  it("completes the very first sweep from a null checkpoint (single-page catalog)", () => {
    const { checkpoint, completedSweep } = advanceReconcileCheckpoint(
      null,
      { nextPageInfo: null, scanned: 40, drifted: 0, corrected: 0 },
      NOW,
    );
    expect(completedSweep).toEqual({
      sweepNumber: 1, startedAt: NOW, completedAt: NOW, pages: 1, variantsScanned: 40, totalDrift: 0, totalCorrected: 0,
    });
    expect(checkpoint.sweepNumber).toBe(1);
    expect(checkpoint.lastSweepCompletedAt).toBe(NOW);
  });
});

describe("formatSweepCompleteAlert", () => {
  it("summarizes a completed sweep with hours elapsed and totals", () => {
    const a = formatSweepCompleteAlert({
      sweepNumber: 3, startedAt: 1_000, completedAt: 1_000 + 18 * 3600,
      pages: 20, variantsScanned: 5000, totalDrift: 12, totalCorrected: 11,
    });
    expect(a.title).toContain("#3");
    expect(a.title).toContain("18h");
    expect(a.title).toContain("20 pages");
    expect(a.message).toContain("5000 variantes vérifiées");
    expect(a.message).toContain("12 écart(s) détecté(s)");
    expect(a.message).toContain("11 corrigé(s)");
  });

  it("rounds up to at least 1h for a sweep that completes within the same hour", () => {
    const a = formatSweepCompleteAlert({
      sweepNumber: 1, startedAt: 1_000, completedAt: 1_100,
      pages: 1, variantsScanned: 40, totalDrift: 0, totalCorrected: 0,
    });
    expect(a.title).toContain("1h");
  });
});
