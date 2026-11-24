import { describe, expect, it, vi } from "vitest";
import {
  MASS_ZERO_FLOOR,
  MAX_SYNC_AGE_S,
  parseStockMode,
  planStockSync,
  runCostwayStockSync,
  targetStock,
  type CostwayStockDeps,
  type CostwayStockRow,
  type StockVariant,
} from "@/lib/costway/stock-sync";

const row = (internalSku: string, over: Partial<CostwayStockRow> = {}): CostwayStockRow => ({
  internalSku, itemNo: "972516483", inStock: true, qty: 46, removed: false, ...over,
});
const live = (sku: string, over: Partial<StockVariant> = {}): StockVariant => ({
  sku, inventoryItemId: `i-${sku}`, inventoryQuantity: 50, tracked: true, ...over,
});

describe("targetStock", () => {
  it("is 0 when removed, not in stock, or under 3 units; else the capped quantity", () => {
    expect(targetStock({ inStock: true, qty: 46, removed: false })).toBe(46);
    expect(targetStock({ inStock: true, qty: 900, removed: false })).toBe(50);
    expect(targetStock({ inStock: true, qty: 2, removed: false })).toBe(0);
    expect(targetStock({ inStock: false, qty: 46, removed: false })).toBe(0); // order #1155: flag 0 but qty 46
    expect(targetStock({ inStock: true, qty: 46, removed: true })).toBe(0);
  });
});

describe("planStockSync", () => {
  it("closes a sold-out colour whose sibling is still in stock (order #1155)", () => {
    const plan = planStockSync(
      [row("MY9SFBY8", { inStock: false }), row("MJX17BCA", { qty: 52 })],
      [live("MY9SFBY8"), live("MJX17BCA", { inventoryQuantity: 50 })],
    );
    expect(plan.changes).toEqual([
      { sku: "MY9SFBY8", itemNo: "972516483", inventoryItemId: "i-MY9SFBY8", from: 50, to: 0, enableTracking: false },
    ]);
    expect(plan.zeroing).toBe(1);
  });

  it("lowers an over-count but never tops a sold-down variant back up", () => {
    const plan = planStockSync(
      [row("A", { qty: 20 }), row("B", { qty: 50 })],
      [live("A", { inventoryQuantity: 50 }), live("B", { inventoryQuantity: 10 })], // B sold down 50→10
    );
    expect(plan.changes.map((c) => [c.sku, c.to])).toEqual([["A", 20]]);
    expect(plan.same).toBe(1);
  });

  it("re-opens a zeroed variant when Costway restocks (0 → N)", () => {
    const plan = planStockSync([row("A", { qty: 30 })], [live("A", { inventoryQuantity: 0 })]);
    expect(plan.changes.map((c) => [c.sku, c.from, c.to])).toEqual([["A", 0, 30]]);
    expect(plan.zeroing).toBe(0);
  });

  it("switches tracking on before zeroing an untracked sold-out variant, and leaves a healthy untracked one alone", () => {
    const plan = planStockSync(
      [row("A", { inStock: false }), row("B")],
      [live("A", { tracked: false, inventoryQuantity: 0 }), live("B", { tracked: false })],
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ sku: "A", to: 0, enableTracking: true });
    expect(plan.same).toBe(1);
  });

  it("never touches a Shopify variant without a Costway row, and counts rows with no variant", () => {
    const plan = planStockSync([row("A"), row("GONE")], [live("A", { inventoryQuantity: 46 }), live("STRANGER")]);
    expect(plan.changes).toEqual([]);
    expect(plan.unmapped).toBe(1);
    expect(plan.missing).toBe(1);
  });

  it("writes zeros before restocks", () => {
    const plan = planStockSync(
      [row("UP", { qty: 30 }), row("DOWN", { inStock: false })],
      [live("UP", { inventoryQuantity: 0 }), live("DOWN")],
    );
    expect(plan.changes.map((c) => c.sku)).toEqual(["DOWN", "UP"]);
  });
});

function makeDeps(over: Partial<CostwayStockDeps> & { rows?: CostwayStockRow[]; variants?: StockVariant[] } = {}) {
  const set = vi.fn(async () => {});
  const track = vi.fn(async () => {});
  const notify = vi.fn(async () => {});
  const nowS = 1_800_000_000;
  const variants = over.variants ?? [live("A"), live("B", { inventoryQuantity: 0 })];
  const deps: CostwayStockDeps = {
    now: () => new Date(nowS * 1000),
    getSetting: async () => null,
    lastCostwaySyncAt: async () => nowS - 3600,
    loadRows: async () => over.rows ?? [row("A", { inStock: false }), row("B", { qty: 30 })],
    productIds: async () => ["1"],
    loadLive: async () => variants,
    getLocation: async () => "loc",
    setInventory: set,
    enableTracking: track,
    readInventory: async (ids) => new Map(ids.map((id) => [id, 0])),
    notify,
    sleep: async () => {},
    log: () => {},
    ...over,
  };
  return { deps, set, track, notify, nowS };
}

describe("runCostwayStockSync", () => {
  it("defaults to dry: plans, reports, writes nothing", async () => {
    expect(parseStockMode(null)).toBe("dry");
    const { deps, set } = makeDeps();
    const r = await runCostwayStockSync({ deps });
    expect(r.mode).toBe("dry");
    expect(r.skipped).toBe("dry-run");
    expect(r.preview.map((p) => p.sku)).toEqual(["A", "B"]);
    expect(set).not.toHaveBeenCalled();
  });

  it("off does nothing at all", async () => {
    const { deps, set } = makeDeps({ getSetting: async () => "off" });
    const r = await runCostwayStockSync({ deps });
    expect(r.skipped).toBe("off");
    expect(set).not.toHaveBeenCalled();
  });

  it("live writes 0 for the sold-out variant and restocks the zeroed one, then verifies", async () => {
    const { deps, set } = makeDeps();
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(set).toHaveBeenCalledWith("i-A", "loc", 0);
    expect(set).toHaveBeenCalledWith("i-B", "loc", 30);
    expect(r).toMatchObject({ applied: 2, zeroed: 1, restored: 1, failed: 0 });
    // canary: B was restocked to 30 but the stub reads 0 → at/below cap, safe
    expect(r.verifyMismatch).toBe(0);
  });

  it("refuses to run on a stale costway-sync", async () => {
    const { deps, set, notify, nowS } = makeDeps({ lastCostwaySyncAt: async () => 1_800_000_000 - MAX_SYNC_AGE_S - 10 });
    void nowS;
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(r.skipped).toBe("stale-costway-sync");
    expect(set).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
    const never = makeDeps({ lastCostwaySyncAt: async () => null });
    expect((await runCostwayStockSync({ deps: never.deps, mode: "live" })).skipped).toBe("stale-costway-sync");
  });

  it("holds back a mass-zero plan (probable feed fault)", async () => {
    const n = MASS_ZERO_FLOOR + 5;
    const rows = Array.from({ length: n }, (_, i) => row(`V${i}`, { inStock: false }));
    const variants = rows.map((r) => live(r.internalSku));
    const { deps, set, notify } = makeDeps({ rows, variants });
    const r = await runCostwayStockSync({ deps, mode: "live" });
    // 155 sellable, all zeroed: limit = max(150, 40% of 155 = 62) = 150 → blocked
    expect(r.skipped).toBe("mass-zero-guard");
    expect(set).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it("applies the per-run cap and reports what is deferred", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`V${i}`, { inStock: false }));
    const { deps, set } = makeDeps({ rows, variants: rows.map((r) => live(r.internalSku)) });
    const r = await runCostwayStockSync({ deps, mode: "live", writeCap: 3 });
    expect(set).toHaveBeenCalledTimes(3);
    expect(r.deferred).toBe(2);
  });

  it("a failed write is counted and does not stop the rest", async () => {
    const set = vi.fn(async (id: string) => { if (id === "i-A") throw new Error("boom"); });
    const { deps, notify } = makeDeps({ setInventory: set });
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(r.failed).toBe(1);
    expect(r.applied).toBe(1);
    expect(notify).toHaveBeenCalled();
  });

  it("flags a write that did not stick (live value above the cap)", async () => {
    const { deps, notify } = makeDeps({ readInventory: async (ids) => new Map(ids.map((id) => [id, 50])) });
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(r.verifyMismatch).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalled();
  });
});
