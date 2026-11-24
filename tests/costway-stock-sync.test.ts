import { describe, expect, it, vi } from "vitest";
import {
  MASS_ZERO_FLOOR,
  MAX_SYNC_AGE_S,
  closedSet,
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
      { sku: "MY9SFBY8", itemNo: "972516483", inventoryItemId: "i-MY9SFBY8", from: 50, to: 0, enableTracking: false, kind: "tighten" },
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

  it("re-opens a variant this job closed when Costway restocks (0 → N)", () => {
    const plan = planStockSync([row("A", { qty: 30 })], [live("A", { inventoryQuantity: 0 })], new Set(["A"]));
    expect(plan.changes.map((c) => [c.sku, c.from, c.to, c.kind])).toEqual([["A", 0, 30, "heal"]]);
    expect(plan.zeroing).toBe(0);
  });

  it("does NOT re-open a variant that customers sold down to 0 while Costway still shows units", () => {
    // 3 units imported, 3 sold on Shopify; Costway's feed still says 3 because Mat has not ordered them yet.
    const plan = planStockSync([row("A", { qty: 3 })], [live("A", { inventoryQuantity: 0 })], new Set());
    expect(plan.changes).toEqual([]);
    expect(plan.same).toBe(1);
  });

  it("an untracked variant gets tracking on, then its target — sellable or not", () => {
    const plan = planStockSync(
      [row("A", { inStock: false }), row("B", { qty: 4 })],
      [live("A", { tracked: false, inventoryQuantity: 0 }), live("B", { tracked: false, inventoryQuantity: 50 })],
    );
    expect(plan.changes.map((c) => [c.sku, c.to, c.enableTracking, c.kind])).toEqual([
      ["A", 0, true, "track"],
      ["B", 4, true, "track"],
    ]);
    expect(plan.zeroing).toBe(1);
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
      new Set(["UP"]),
    );
    expect(plan.changes.map((c) => c.sku)).toEqual(["DOWN", "UP"]);
  });

  it("closedSet = rows whose target is 0", () => {
    expect(closedSet([row("A", { inStock: false }), row("B"), row("C", { qty: 1 }), row("D", { removed: true })])).toEqual(["A", "C", "D"]);
  });
});

function makeDeps(over: Partial<CostwayStockDeps> & { rows?: CostwayStockRow[]; variants?: StockVariant[]; closed?: string[] } = {}) {
  const set = vi.fn(async () => {});
  const track = vi.fn(async () => {});
  const notify = vi.fn(async () => {});
  const saved: string[][] = [];
  const settings = new Map<string, string>();
  const nowS = 1_800_000_000;
  const variants = over.variants ?? [live("A"), live("B", { inventoryQuantity: 0 })];
  const deps: CostwayStockDeps = {
    now: () => new Date(nowS * 1000),
    getSetting: async (k) => settings.get(k) ?? null,
    setSetting: async (k, v) => { settings.set(k, v); },
    lastCostwaySyncAt: async () => nowS - 3600,
    loadRows: async () => over.rows ?? [row("A", { inStock: false }), row("B", { qty: 30 })],
    productIds: async () => ["1"],
    loadLive: async () => variants,
    loadClosed: async () => new Set(over.closed ?? ["B"]),
    saveClosed: async (s) => { saved.push(s); },
    getLocation: async () => "loc",
    setInventory: set,
    enableTracking: track,
    // fresh read = what the plan saw (A at 50, B at 0)
    readInventory: async (ids) => new Map(ids.map((id) => [id, id === "i-B" ? 0 : 50])),
    notify,
    sleep: async () => {},
    log: () => {},
    ...over,
  };
  return { deps, set, track, notify, saved, settings };
}

describe("runCostwayStockSync", () => {
  it("defaults to dry: plans, reports, writes nothing, saves nothing", async () => {
    expect(parseStockMode(null)).toBe("dry");
    const { deps, set, saved } = makeDeps();
    const r = await runCostwayStockSync({ deps });
    expect(r.mode).toBe("dry");
    expect(r.skipped).toBe("dry-run");
    expect(r.preview.map((p) => p.sku)).toEqual(["A", "B"]);
    expect(set).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("off does nothing at all", async () => {
    const { deps, set } = makeDeps({ getSetting: async () => "off" });
    const r = await runCostwayStockSync({ deps });
    expect(r.skipped).toBe("off");
    expect(set).not.toHaveBeenCalled();
  });

  it("live closes the sold-out variant, re-opens the one it had closed, saves the closed set", async () => {
    const { deps, set, saved } = makeDeps();
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(set).toHaveBeenCalledWith("i-A", "loc", 0);
    expect(set).toHaveBeenCalledWith("i-B", "loc", 30);
    expect(r).toMatchObject({ applied: 2, zeroed: 1, restored: 1, failed: 0, staleSkipped: 0 });
    expect(saved).toEqual([["A"]]); // only A has a 0 target now
  });

  it("skips a write whose fresh Shopify read no longer justifies it (a sale landed meanwhile)", async () => {
    const rows = [row("A", { qty: 5 }), row("B", { qty: 30 })];
    const variants = [live("A", { inventoryQuantity: 30 }), live("B", { inventoryQuantity: 0 })];
    const { deps, set } = makeDeps({
      rows, variants, closed: ["B"],
      // A sold down to 2 (plan said 30→5: writing 5 would RAISE it); B was re-stocked by hand to 12 (no longer 0)
      readInventory: async () => new Map([["i-A", 2], ["i-B", 12]]),
    });
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(set).not.toHaveBeenCalled();
    expect(r.staleSkipped).toBe(2);
    expect(r.applied).toBe(0);
  });

  it("refuses to run on a stale costway-sync, and alerts once a day", async () => {
    const { deps, set, notify } = makeDeps({ lastCostwaySyncAt: async () => 1_800_000_000 - MAX_SYNC_AGE_S - 10 });
    expect((await runCostwayStockSync({ deps, mode: "live" })).skipped).toBe("stale-costway-sync");
    expect((await runCostwayStockSync({ deps, mode: "live" })).skipped).toBe("stale-costway-sync");
    expect(set).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    const never = makeDeps({ lastCostwaySyncAt: async () => null });
    expect((await runCostwayStockSync({ deps: never.deps, mode: "live" })).skipped).toBe("stale-costway-sync");
  });

  it("holds back a mass-zero plan (probable feed fault) unless forced", async () => {
    const n = MASS_ZERO_FLOOR + 5;
    const rows = Array.from({ length: n }, (_, i) => row(`V${i}`, { inStock: false }));
    const variants = rows.map((r) => live(r.internalSku));
    const held = makeDeps({ rows, variants });
    const r = await runCostwayStockSync({ deps: held.deps, mode: "live" });
    // 155 sellable, all zeroed: limit = max(150, 40% of 155 = 62) = 150 → blocked
    expect(r.skipped).toBe("mass-zero-guard");
    expect(held.set).not.toHaveBeenCalled();
    expect(held.saved).toEqual([]);
    expect(held.notify).toHaveBeenCalledTimes(1);
    await runCostwayStockSync({ deps: held.deps, mode: "live" });
    expect(held.notify).toHaveBeenCalledTimes(1); // same day → no second alert

    const forced = makeDeps({ rows, variants, readInventory: async (ids) => new Map(ids.map((id) => [id, 50])) });
    const f = await runCostwayStockSync({ deps: forced.deps, mode: "live", force: true, writeCap: 400 });
    expect(f.skipped).toBeUndefined();
    expect(forced.set).toHaveBeenCalledTimes(n);
  });

  it("applies the per-run cap and reports what is deferred", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`V${i}`, { inStock: false }));
    const { deps, set } = makeDeps({ rows, variants: rows.map((r) => live(r.internalSku)), readInventory: async (ids) => new Map(ids.map((id) => [id, 50])) });
    const r = await runCostwayStockSync({ deps, mode: "live", writeCap: 3 });
    expect(set).toHaveBeenCalledTimes(3);
    expect(r.deferred).toBe(2);
  });

  it("an untracked variant is tracked first, then written (no fresh-read gate)", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      rows: [row("A", { inStock: false })],
      variants: [live("A", { tracked: false, inventoryQuantity: 0 })],
      enableTracking: async () => { order.push("track"); },
      setInventory: async () => { order.push("set"); },
      readInventory: async (ids) => new Map(ids.map((id) => [id, 0])),
    });
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(order).toEqual(["track", "set"]);
    expect(r.trackingEnabled).toBe(1);
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
    let call = 0;
    const { deps, notify } = makeDeps({
      // 1st read = before writing (matches the plan); 2nd read = canary (write did not stick: still 50)
      readInventory: async (ids) => { call++; return new Map(ids.map((id) => [id, call === 1 ? (id === "i-B" ? 0 : 50) : 50])); },
    });
    const r = await runCostwayStockSync({ deps, mode: "live" });
    expect(r.verifyMismatch).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalled();
  });
});
