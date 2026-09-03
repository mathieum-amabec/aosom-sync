import { describe, it, expect, vi } from "vitest";
import { runPriceReconcile, runPostSyncSample, MAX_CORRECTIONS_PER_RECONCILE } from "@/lib/price-reconcile";

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
