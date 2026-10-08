import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  ensureSchema: vi.fn(), getSetting: vi.fn(), setSetting: vi.fn(),
  getDailyLlmTokensUsed: vi.fn(), addDailyLlmTokens: vi.fn(),
}));
vi.mock("@/lib/csv-fetcher", () => ({ fetchAosomCatalog: vi.fn() }));
vi.mock("@/lib/variant-merger", () => ({ mergeVariants: vi.fn() }));
vi.mock("@/lib/auto-import/process-one", () => ({ processCandidate: vi.fn() }));

import { runAutoImportTick, MODE_KEY, STATE_KEY, PLAN_KEY, CAP_KEY, type TickDeps } from "@/lib/auto-import/run";
import { LlmBudgetExceededError } from "@/lib/llm-budget";
import type { AosomMergedProduct, AosomVariant } from "@/types/aosom";
import type { ProcessResult } from "@/lib/auto-import/process-one";

const NOON = new Date("2026-10-08T14:00:00Z"); // 10:00 Montréal, inside the pacing window

function variant(sku: string): AosomVariant {
  return { sku, price: 100, qty: 50, color: "", size: "", gtin: "", weight: 5, dimensions: { length: 1, width: 1, height: 1 }, images: [], estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "" };
}
function group(key: string, productType = "Toys & Games"): AosomMergedProduct {
  return { groupKey: key, name: `Jouet ${key}`, brand: "x", productType, category: "", description: "d", shortDescription: "", material: "", images: ["a", "b", "c"], video: "", pdf: "", variants: [variant(`${key}-A`)] };
}

function makeDeps(over: Partial<Omit<TickDeps, "now">> & { settings?: Record<string, string>; groups?: AosomMergedProduct[]; now?: Date } = {}) {
  const { settings, groups, now, ...rest } = over;
  const store: Record<string, string> = { ...(settings ?? {}) };
  const process = vi.fn(async (c: { groupKey: string }, mode: string): Promise<ProcessResult> => { void mode; return { outcome: "live", groupKey: c.groupKey, shopifyId: "1", reasons: [] }; });
  const deps: TickDeps = {
    now: () => now ?? NOON,
    getSetting: async (k) => store[k] ?? null,
    setSetting: async (k, v) => { store[k] = v; },
    loadCatalog: async () => ({ groups: groups ?? Array.from({ length: 20 }, (_, i) => group(`g${i}`)), skuCount: 7990 }),
    loadImportedSkus: async () => new Set(),
    loadFirstSeen: async () => new Map(),
    loadJobs: async () => new Map(),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
    process,
    ...rest,
  } as TickDeps;
  return { deps, store, process };
}

beforeEach(() => vi.clearAllMocks());

describe("runAutoImportTick", () => {
  it("does nothing while the mode is off (the default)", async () => {
    const { deps, process } = makeDeps();
    const r = await runAutoImportTick({ deps });
    expect(r.skipped).toBe("off");
    expect(process).not.toHaveBeenCalled();
    expect(deps.acquireLock).not.toHaveBeenCalled();
  });

  it("dry mode records the plan and writes nothing", async () => {
    const { deps, store, process } = makeDeps({ settings: { [MODE_KEY]: "dry" } });
    const r = await runAutoImportTick({ deps });
    expect(r.skipped).toBe("dry-run");
    expect(r.picked.length).toBeGreaterThan(0);
    expect(process).not.toHaveBeenCalled();
    expect(JSON.parse(store[PLAN_KEY]).next.length).toBe(r.picked.length);
    expect(store[STATE_KEY]).toBeUndefined();
  });

  it("live mode processes at most 3 per tick, counts them, and releases the lock", async () => {
    const { deps, store, process } = makeDeps({ settings: { [MODE_KEY]: "live" } });
    const r = await runAutoImportTick({ deps });
    expect(process).toHaveBeenCalledTimes(3);
    expect(r.results).toHaveLength(3);
    const state = JSON.parse(store[STATE_KEY]);
    expect(state.total).toBe(3);
    expect(state.toys).toBe(3);
    expect(state.byCat["Toys & Games"]).toBe(3);
    expect(deps.releaseLock).toHaveBeenCalledOnce();
  });

  it("pilot mode passes the mode through and stops at the pilot cap", async () => {
    const { deps, store, process } = makeDeps({ settings: { [MODE_KEY]: "pilot", [STATE_KEY]: JSON.stringify({ day: "2026-10-08", total: 10, toys: 0, byCat: {}, newCount: 0, needsReview: 0, failed: 0 }) } });
    expect((await runAutoImportTick({ deps })).skipped).toBe("cap-reached");
    expect(process).not.toHaveBeenCalled();
    const second = makeDeps({ settings: { [MODE_KEY]: "pilot" } });
    await runAutoImportTick({ deps: second.deps });
    expect(second.process.mock.calls[0][1]).toBe("pilot");
    expect(store[STATE_KEY]).toBeDefined();
  });

  it("respects a custom daily cap and the day's pace", async () => {
    const early = makeDeps({ settings: { [MODE_KEY]: "live" }, now: new Date("2026-10-08T06:30:00Z") });
    expect((await runAutoImportTick({ deps: early.deps })).skipped).toBe("pace");
    const capped = makeDeps({ settings: { [MODE_KEY]: "live", [CAP_KEY]: "2" } });
    await runAutoImportTick({ deps: capped.deps });
    expect(capped.process).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh count on a new Montréal day", async () => {
    const { deps, store } = makeDeps({ settings: { [MODE_KEY]: "live", [STATE_KEY]: JSON.stringify({ day: "2026-10-07", total: 100, toys: 60, byCat: {}, newCount: 0, needsReview: 0, failed: 0 }) } });
    await runAutoImportTick({ deps });
    expect(JSON.parse(store[STATE_KEY]).day).toBe("2026-10-08");
    expect(JSON.parse(store[STATE_KEY]).total).toBe(3);
  });

  it("refuses a truncated feed and still releases the lock", async () => {
    const { deps, process } = makeDeps({ settings: { [MODE_KEY]: "live" }, loadCatalog: async () => ({ groups: [], skuCount: 1200 }) });
    const r = await runAutoImportTick({ deps });
    expect(r.skipped).toBe("feed-incomplete:1200");
    expect(process).not.toHaveBeenCalled();
    expect(deps.releaseLock).toHaveBeenCalledOnce();
  });

  it("skips when another tick holds the lock", async () => {
    const { deps, process } = makeDeps({ settings: { [MODE_KEY]: "live" }, acquireLock: vi.fn(async () => false) });
    expect((await runAutoImportTick({ deps })).skipped).toBe("locked");
    expect(process).not.toHaveBeenCalled();
    expect(deps.releaseLock).not.toHaveBeenCalled();
  });

  it("stops the tick when the import token pool is exhausted", async () => {
    const { deps } = makeDeps({ settings: { [MODE_KEY]: "live" } });
    deps.process = vi.fn(async () => { throw new LlmBudgetExceededError("import", 3_000_001, 3_000_000); });
    const r = await runAutoImportTick({ deps });
    expect(r.skipped).toBe("llm-budget-exhausted");
    expect(deps.process).toHaveBeenCalledTimes(1);
  });

  it("counts verification failures and errors, and pauses when too many fail", async () => {
    const state = { day: "2026-10-08", total: 6, toys: 6, byCat: {}, newCount: 0, needsReview: 3, failed: 0 };
    const { deps, store } = makeDeps({ settings: { [MODE_KEY]: "live", [STATE_KEY]: JSON.stringify(state) } });
    deps.process = vi.fn(async (c): Promise<ProcessResult> => ({ outcome: "needs_review", groupKey: c.groupKey, layer: "judge", reasons: ["x"] }));
    const r = await runAutoImportTick({ deps });
    expect(r.skipped).toBe("paused-high-failure-rate");
    expect(JSON.parse(store[STATE_KEY]).needsReview).toBeGreaterThan(3);
    // and the next tick of the same day stays paused
    expect((await runAutoImportTick({ deps })).skipped).toBe("paused-high-failure-rate");
  });

  it("turns an unexpected throw into a counted error, not a crashed tick", async () => {
    const { deps, store } = makeDeps({ settings: { [MODE_KEY]: "live" } });
    deps.process = vi.fn(async () => { throw new Error("boom"); });
    const r = await runAutoImportTick({ deps });
    expect(r.results.every((x) => x.outcome === "error")).toBe(true);
    expect(JSON.parse(store[STATE_KEY]).failed).toBe(3);
  });
});
