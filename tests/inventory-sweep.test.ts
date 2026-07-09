import { describe, it, expect, vi } from "vitest";
import { planInventorySweep, runInventorySweep, type SweepVariant } from "@/lib/inventory-sweep";

// stockBufferQty(40) = 37, stockBufferQty(30) = 27 (qty>10 → qty-3). Used as restore targets.
const v = (sku: string, inv: number, opts: { tracked?: boolean; item?: string } = {}): SweepVariant => ({
  sku, inventoryQuantity: inv, inventoryItemId: opts.item ?? `i-${sku}`, tracked: opts.tracked ?? true,
});
const feed = (entries: Array<[string, number]>) => new Map(entries.map(([s, q]) => [s.toUpperCase(), q]));

describe("planInventorySweep — feed-aware reconcile", () => {
  it("targets 0 for a tracked variant absent from the feed (inv>0)", () => {
    const plan = planInventorySweep({ variants: [v("A", 7)], feedQty: feed([["B", 50]]), soldOutMax: 10, minCoverage: 0 });
    expect(plan.toSet).toEqual([{ sku: "A", inventoryItemId: "i-A", from: 7, to: 0 }]);
  });

  it("targets 0 when feed_qty <= threshold", () => {
    const plan = planInventorySweep({ variants: [v("A", 19)], feedQty: feed([["A", 8]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([{ sku: "A", inventoryItemId: "i-A", from: 19, to: 0 }]);
  });

  it("RESTORES a wrongly-zeroed variant that is back in the feed (self-heal)", () => {
    // inv 0 but feed_qty 40 → target stockBufferQty(40)=37 → restore 0→37
    const plan = planInventorySweep({ variants: [v("A", 0)], feedQty: feed([["A", 40]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([{ sku: "A", inventoryItemId: "i-A", from: 0, to: 37 }]);
  });

  it("no write when Shopify already matches the buffered feed target", () => {
    const plan = planInventorySweep({ variants: [v("A", 37)], feedQty: feed([["A", 40]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([]);
  });

  it("leaves a nonzero→nonzero drift alone (not the oversell boundary — daily push owns it)", () => {
    // Shopify 39 vs feed 16 → buffered target 13, but both sides > 0 → out of scope, no write
    const plan = planInventorySweep({ variants: [v("A", 39)], feedQty: feed([["A", 16]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([]);
  });

  it("no write when absent AND already 0 (idempotent)", () => {
    const plan = planInventorySweep({ variants: [v("A", 0)], feedQty: feed([["B", 50]]), soldOutMax: 10, minCoverage: 0 });
    expect(plan.toSet).toEqual([]);
  });

  it("does NOT touch an untracked variant (can't set inventory)", () => {
    const plan = planInventorySweep({ variants: [v("A", 7, { tracked: false })], feedQty: feed([["B", 50]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([]);
    expect(plan.guard.activeTracked).toBe(0); // untracked excluded from coverage denominator
  });

  it("skips a variant with no inventory_item_id", () => {
    const plan = planInventorySweep({ variants: [v("A", 7, { item: "" })], feedQty: feed([["B", 50]]), soldOutMax: 10, minCoverage: 0 });
    expect(plan.toSet).toEqual([]);
  });

  it("feed-completeness guard trips (< 80% coverage) → no writes at all", () => {
    const variants = ["A", "B", "C", "D", "E"].map((s) => v(s, 20));
    const plan = planInventorySweep({ variants, feedQty: feed([["A", 40], ["B", 40], ["C", 40]]), soldOutMax: 10 });
    expect(plan.guard.ok).toBe(false);
    expect(plan.guard.coverage).toBeCloseTo(0.6);
    expect(plan.toSet).toEqual([]);
  });

  it("proceeds at >= 80% coverage, zeroing the absent ones", () => {
    const covered = Array.from({ length: 8 }, (_, i) => v(`C${i}`, 37));   // in feed at 40 → target 37 → no write
    const gone = [v("G1", 15), v("G2", 15)];                                // absent → 0
    const feedMap = feed(covered.map((x) => [x.sku, 40] as [string, number]));
    const plan = planInventorySweep({ variants: [...covered, ...gone], feedQty: feedMap, soldOutMax: 10 });
    expect(plan.guard.ok).toBe(true);
    expect(plan.toSet.map((t) => t.sku).sort()).toEqual(["G1", "G2"]);
    expect(plan.toSet.every((t) => t.to === 0)).toBe(true);
  });
});

describe("runInventorySweep — I/O wiring (injected deps)", () => {
  const fillers = (n: number) => Array.from({ length: n }, (_, i) => v(`F${i}`, 37)); // in feed@40 → target 37 → no write
  const fillerFeed = (n: number) => Array.from({ length: n }, (_, i) => [`F${i}`, 40] as [string, number]);
  const baseDeps = (variants: SweepVariant[], feedEntries: Array<[string, number]>) => {
    const setInventory = vi.fn().mockResolvedValue(undefined);
    return {
      setInventory,
      fetchFeed: vi.fn().mockResolvedValue(feedEntries.map(([sku, qty]) => ({ sku, qty }))),
      fetchVariants: vi.fn().mockResolvedValue(variants),
      getLocation: vi.fn().mockResolvedValue("loc-1"),
      rateLimitMs: 0, log: () => {},
    };
  };

  it("zeroes absent+low and restores back-in-feed variants", async () => {
    const deps = baseDeps(
      [v("GONE", 12), v("LOW", 30), v("BACK", 0), v("OK", 37), ...fillers(8)],
      [["LOW", 5], ["BACK", 40], ["OK", 40], ...fillerFeed(8)],
    );
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(2);     // GONE, LOW
    expect(res.restored).toBe(1);   // BACK 0→37
    expect(deps.setInventory).toHaveBeenCalledWith("i-GONE", "loc-1", 0);
    expect(deps.setInventory).toHaveBeenCalledWith("i-LOW", "loc-1", 0);
    expect(deps.setInventory).toHaveBeenCalledWith("i-BACK", "loc-1", 37);
    expect(deps.setInventory).not.toHaveBeenCalledWith("i-OK", "loc-1", 37);
  });

  it("guard tripped → no location fetch, no writes", async () => {
    const deps = baseDeps([v("A", 20), v("B", 20), v("C", 20), v("D", 20)], [["Z", 40]]);
    const res = await runInventorySweep(deps);
    expect(res.guardTripped).toBe(true);
    expect(deps.getLocation).not.toHaveBeenCalled();
    expect(deps.setInventory).not.toHaveBeenCalled();
  });

  it("processes zeros before restores and caps writes per run (convergent)", async () => {
    // 2 zeros + 2 restores, cap 3 → 3 written (zeros first), 1 deferred
    const deps = { ...baseDeps(
      [v("Z1", 12), v("Z2", 12), v("R1", 0), v("R2", 0), ...fillers(8)],
      [["R1", 40], ["R2", 40], ...fillerFeed(8)],
    ), writeCap: 3 };
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(2);
    expect(res.restored).toBe(1);
    expect(res.deferred).toBe(1);
  });

  it("a per-variant failure is counted, never aborts the batch", async () => {
    const deps = baseDeps([v("G1", 12), v("G2", 12), ...fillers(8)], fillerFeed(8));
    deps.setInventory.mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(undefined);
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(1);
    expect(res.failed).toBe(1);
    expect(deps.setInventory).toHaveBeenCalledTimes(2);
  });

  it("nothing to set → clean no-op result", async () => {
    const deps = baseDeps([v("A", 37), v("B", 37)], [["A", 40], ["B", 40]]);
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(0);
    expect(res.restored).toBe(0);
    expect(deps.getLocation).not.toHaveBeenCalled();
  });
});
