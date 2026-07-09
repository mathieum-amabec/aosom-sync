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

  it("LEAVES a sold-down nonzero variant alone (never refills upward against the 06:00 feed)", () => {
    // Shopify 20 vs feed 40 → buffered target 37. Refilling 20→37 would reopen intraday
    // oversell under deny, so downward-safe reconcile leaves it for the change-gated push.
    const plan = planInventorySweep({ variants: [v("A", 20)], feedQty: feed([["A", 40]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([]);
  });

  it("CORRECTS an over-count downward (Shopify above the buffered cap → tighten)", () => {
    // Shopify 39 vs feed 16 → buffered target 13. 13 < 39 → write 39→13 (stop the oversell).
    const plan = planInventorySweep({ variants: [v("A", 39)], feedQty: feed([["A", 16]]), soldOutMax: 10 });
    expect(plan.toSet).toEqual([{ sku: "A", inventoryItemId: "i-A", from: 39, to: 13 }]);
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

  it("feed-completeness guard trips (< 70% coverage) → no writes at all", () => {
    const variants = ["A", "B", "C", "D", "E"].map((s) => v(s, 20));   // 3/5 = 0.6 < 0.7
    const plan = planInventorySweep({ variants, feedQty: feed([["A", 40], ["B", 40], ["C", 40]]), soldOutMax: 10 });
    expect(plan.guard.ok).toBe(false);
    expect(plan.guard.coverage).toBeCloseTo(0.6);
    expect(plan.toSet).toEqual([]);
  });

  it("70% threshold boundary: 7/10 proceeds, 6/10 trips", () => {
    const mk = (n: number) => Array.from({ length: 10 }, (_, i) => v(`X${i}`, 20));
    const covers = (n: number) => feed(Array.from({ length: n }, (_, i) => [`X${i}`, 40] as [string, number]));
    expect(planInventorySweep({ variants: mk(10), feedQty: covers(7), soldOutMax: 10 }).guard.ok).toBe(true);  // 0.70 → ok
    expect(planInventorySweep({ variants: mk(10), feedQty: covers(6), soldOutMax: 10 }).guard.ok).toBe(false); // 0.60 → trip
  });

  it("proceeds at >= 70% coverage, zeroing the absent ones", () => {
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
    // Simulated Shopify inventory store: setInventory writes it, readInventory (canary) reads it,
    // so a write "sticks" by default and the post-write canary verifies cleanly unless overridden.
    const store = new Map<string, number>();
    const setInventory = vi.fn(async (itemId: string, _loc: string, avail: number) => { store.set(itemId, avail); });
    // Real readInventoryLevels omits ids Shopify has no level for; mirror that (present ids only).
    const readInventory = vi.fn(async (ids: string[]): Promise<Map<string, number>> => {
      const m = new Map<string, number>();
      for (const id of ids) { const val = store.get(id); if (val !== undefined) m.set(id, val); }
      return m;
    });
    const notify = vi.fn().mockResolvedValue(1);
    return {
      store, setInventory, readInventory, notify,
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

  it("leaves a sold-down nonzero variant alone but still tightens an over-count", async () => {
    // SOLD 22 vs feed 40 (target 37) → upward, left alone. OVER 60 vs feed 40 (target 37) →
    // downward over-count, written 60→37. Downward-safe: only the tighten happens.
    const deps = baseDeps([v("SOLD", 22), v("OVER", 60), ...fillers(8)], [["SOLD", 40], ["OVER", 40], ...fillerFeed(8)]);
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(0);
    expect(res.restored).toBe(1); // OVER 60→37 (positive target) buckets as restored/adjusted
    expect(deps.setInventory).toHaveBeenCalledWith("i-OVER", "loc-1", 37);
    expect(deps.setInventory).not.toHaveBeenCalledWith("i-SOLD", "loc-1", 37);
  });

  it("guard tripped → no location fetch, no writes, RAISES a notification", async () => {
    const deps = baseDeps([v("A", 20), v("B", 20), v("C", 20), v("D", 20)], [["Z", 40]]);
    const res = await runInventorySweep(deps);
    expect(res.guardTripped).toBe(true);
    expect(deps.getLocation).not.toHaveBeenCalled();
    expect(deps.setInventory).not.toHaveBeenCalled();
    // Fix #2: the abort is surfaced in the dashboard, not silent.
    expect(deps.notify).toHaveBeenCalledWith("inventory-sweep", expect.stringContaining("aborté"), expect.stringContaining("couverture"));
  });

  it("post-write canary re-reads what it wrote and confirms it stuck (verified count)", async () => {
    const deps = baseDeps([v("GONE", 12), v("OVER", 60), ...fillers(8)], [["OVER", 40], ...fillerFeed(8)]);
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(1);            // GONE → 0
    expect(res.restored).toBe(1);          // OVER 60 → 37
    expect(res.verified).toBe(2);          // both re-read and matched the simulated store
    expect(res.verifyMismatch).toBe(0);
    expect(deps.readInventory).toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("canary MISMATCH: variant ABOVE its cap after write (oversell) → counts + notifies", async () => {
    const deps = baseDeps([v("GONE", 12), ...fillers(8)], fillerFeed(8));
    // Simulate Shopify NOT applying the write: live value is still ABOVE the target (99 > 0).
    deps.readInventory.mockResolvedValueOnce(new Map([["i-GONE", 99]]));
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(1);
    expect(res.verified).toBe(0);
    expect(res.verifyMismatch).toBe(1);
    expect(deps.notify).toHaveBeenCalledWith("inventory-sweep", expect.stringContaining("oversell"), expect.stringContaining("GONE"));
  });

  it("canary does NOT flag a live value BELOW the cap (intraday sale) as a mismatch", async () => {
    // OVER 60 → cap 37. A customer buys after the write → Shopify reads 30 (< 37). Under deny that
    // is safe (not oversellable), so it must count as verified, NOT a mismatch (no false alert).
    const deps = baseDeps([v("OVER", 60), ...fillers(8)], [["OVER", 40], ...fillerFeed(8)]);
    deps.readInventory.mockResolvedValueOnce(new Map([["i-OVER", 30]]));
    const res = await runInventorySweep(deps);
    expect(res.restored).toBe(1);
    expect(res.verified).toBe(1);         // 30 <= 37 → at/below cap → safe
    expect(res.verifyMismatch).toBe(0);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("a canary read failure never fails the sweep (writes already succeeded)", async () => {
    const deps = baseDeps([v("GONE", 12), ...fillers(8)], fillerFeed(8));
    deps.readInventory.mockRejectedValueOnce(new Error("timeout"));
    const res = await runInventorySweep(deps);
    expect(res.zeroed).toBe(1);
    expect(res.verified).toBe(0);
    expect(res.verifyMismatch).toBe(0);   // read failed → no verification, but no crash
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
