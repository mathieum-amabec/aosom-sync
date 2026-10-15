import { describe, it, expect, vi } from "vitest";
import {
  referencePrice,
  planCompareAt,
  runCompareAtSync,
  parseCompareAtMode,
  MAX_WRITES_PER_RUN,
  COMPARE_AT_PLAN_KEY,
  type CompareAtDeps,
  type LiveVariant,
  type PriceSource,
  type PriceStep,
} from "@/lib/compare-at";

const NOW = Math.floor(Date.UTC(2026, 9, 14, 12, 0, 0) / 1000);
const ago = (days: number) => NOW - days * 86_400;
const step = (oldPrice: number, newPrice: number, daysAgo: number): PriceStep => ({ oldPrice, newPrice, at: ago(daysAgo) });

describe("referencePrice", () => {
  it("counts a slide in small steps: each step < 10 % but the total is 15 %", () => {
    // 53.99 for 30 days, then 48.99 for 10 days, now 45.99
    const steps = [step(53.99, 48.99, 30), step(48.99, 45.99, 20)];
    expect(referencePrice(45.99, steps, ago(60), NOW)).toBe(53.99);
  });

  it("shows the previous price after a single drop of 10 % or more", () => {
    expect(referencePrice(59.99, [step(72.99, 59.99, 10)], ago(40), NOW)).toBe(72.99);
  });

  it("ignores a price that was only held a few days (under 14)", () => {
    // 60 for a long time, a 5-day spike to 80, back to 60: the spike is not a reference
    const steps = [step(60, 80, 8), step(80, 60, 3)];
    expect(referencePrice(60, steps, ago(50), NOW)).toBeNull();
  });

  it("ignores a price older than the 90-day window", () => {
    expect(referencePrice(60, [step(70, 60, 100)], ago(200), NOW)).toBeNull();
  });

  it("needs a discount of at least 10 %", () => {
    expect(referencePrice(46, [step(50, 46, 10)], ago(40), NOW)).toBeNull(); // 8 %
    expect(referencePrice(45, [step(50, 45, 10)], ago(40), NOW)).toBe(50); // exactly 10 %
  });

  it("takes the highest qualifying price, not the latest", () => {
    // 100 for 30 d, 90 for 20 d, now 80 -> reference 100
    const steps = [step(100, 90, 30), step(90, 80, 10)];
    expect(referencePrice(80, steps, ago(60), NOW)).toBe(100);
  });

  it("returns null with no price change, with only no-op rows, or with an unprovable first segment", () => {
    expect(referencePrice(50, [], ago(100), NOW)).toBeNull();
    expect(referencePrice(50, [step(50, 50, 20)], ago(100), NOW)).toBeNull();
    expect(referencePrice(80, [step(100, 80, 10)], null, NOW)).toBeNull(); // first-seen unknown: cannot prove the 100
  });

  it("returns null for an invalid current price", () => {
    expect(referencePrice(0, [step(10, 5, 20)], ago(60), NOW)).toBeNull();
    expect(referencePrice(NaN, [step(10, 5, 20)], ago(60), NOW)).toBeNull();
  });
});

const live = (sku: string, price: number, compareAtPrice: number | null = null): LiveVariant => ({ sku, variantId: `v-${sku}`, price, compareAtPrice });
const src = (dbPrice: number, steps: PriceStep[], firstSeenDaysAgo = 60): PriceSource => ({ dbPrice, steps, firstSeenAt: ago(firstSeenDaysAgo) });

describe("planCompareAt", () => {
  it("sets a missing crossed price, keeps a valid one, clears an invalid one", () => {
    const sources = new Map<string, PriceSource>([
      ["A", src(59.99, [step(72.99, 59.99, 10)])],
      ["B", src(59.99, [step(72.99, 59.99, 10)])],
      ["C", src(100, [])],
    ]);
    const p = planCompareAt([live("A", 59.99), live("B", 59.99, 80), live("C", 100, 105)], sources, NOW);
    expect(p.changes).toEqual([
      expect.objectContaining({ sku: "A", action: "set", to: 72.99 }),
      expect.objectContaining({ sku: "C", action: "clear", from: 105, to: null }),
    ]);
    expect(p.keptValid).toBe(1); // B already shows a valid 80
  });

  it("never overwrites an already-valid crossed price", () => {
    const sources = new Map([["A", src(59.99, [step(72.99, 59.99, 10)])]]);
    const p = planCompareAt([live("A", 59.99, 69.99)], sources, NOW);
    expect(p.changes).toHaveLength(0);
    expect(p.keptValid).toBe(1);
  });

  it("waits when the Shopify price differs from the database price (the price reconcile fixes it first)", () => {
    const sources = new Map([["A", src(55.99, [step(72.99, 55.99, 10)])]]);
    const p = planCompareAt([live("A", 59.99)], sources, NOW);
    expect(p.skippedDrift).toBe(1);
    expect(p.changes).toHaveLength(0);
  });

  it("counts variants with no database row and leaves them alone", () => {
    const p = planCompareAt([live("X", 10, 20)], new Map(), NOW);
    expect(p.noHistory).toBe(1);
    expect(p.changes).toHaveLength(0);
  });
});

function makeDeps(over: { live?: LiveVariant[]; sources?: Map<string, PriceSource>; mode?: string; write?: CompareAtDeps["writeCompareAt"] } = {}) {
  const store: Record<string, string> = over.mode ? { compare_at_mode: over.mode } : {};
  const filler = Array.from({ length: 600 }, (_, i) => live(`F${i}`, 20));
  const deps: CompareAtDeps = {
    now: () => new Date(NOW * 1000),
    getSetting: async (k) => store[k] ?? null,
    setSetting: async (k, v) => { store[k] = v; },
    loadLiveVariants: async () => over.live ?? [...filler, live("A", 59.99)],
    loadSources: async () => over.sources ?? new Map([["A", src(59.99, [step(72.99, 59.99, 10)])]]),
    writeCompareAt: over.write ?? vi.fn(async () => {}),
  };
  return { deps, store };
}

describe("runCompareAtSync", () => {
  it("does nothing while off (the default)", async () => {
    const { deps } = makeDeps();
    const r = await runCompareAtSync({ deps });
    expect(r.skipped).toBe("off");
    expect(deps.writeCompareAt).not.toHaveBeenCalled();
  });

  it("dry mode stores the plan and writes nothing to Shopify", async () => {
    const { deps, store } = makeDeps({ mode: "dry" });
    const r = await runCompareAtSync({ deps });
    expect(r.skipped).toBe("dry-run");
    expect(r.plan.changes).toHaveLength(1);
    expect(deps.writeCompareAt).not.toHaveBeenCalled();
    expect(JSON.parse(store[COMPARE_AT_PLAN_KEY]).set).toBe(1);
  });

  it("dry mode can skip persisting (for the standalone dry run)", async () => {
    const { deps, store } = makeDeps({ mode: "dry" });
    await runCompareAtSync({ deps, persistPlan: false });
    expect(store[COMPARE_AT_PLAN_KEY]).toBeUndefined();
  });

  it("live mode writes the crossed price and counts it", async () => {
    const { deps } = makeDeps({ mode: "live" });
    const r = await runCompareAtSync({ deps });
    expect(r.applied).toBe(1);
    expect(deps.writeCompareAt).toHaveBeenCalledWith("v-A", 72.99);
  });

  it("counts a failed write without stopping the run", async () => {
    const live2 = [...Array.from({ length: 600 }, (_, i) => live(`F${i}`, 20)), live("A", 59.99), live("B", 59.99)];
    const sources = new Map([["A", src(59.99, [step(72.99, 59.99, 10)])], ["B", src(59.99, [step(72.99, 59.99, 10)])]]);
    const write = vi.fn(async (id: string) => { if (id === "v-A") throw new Error("boom"); });
    const { deps } = makeDeps({ mode: "live", live: live2, sources, write });
    const r = await runCompareAtSync({ deps });
    expect(r.failed).toBe(1);
    expect(r.applied).toBe(1);
  });

  it("changes nothing when the Shopify listing looks truncated", async () => {
    const { deps } = makeDeps({ mode: "live", live: [live("A", 59.99)] });
    const r = await runCompareAtSync({ deps });
    expect(r.skipped).toContain("listing-incomplete");
    expect(deps.writeCompareAt).not.toHaveBeenCalled();
  });

  it("caps the writes per run and reports what was deferred", async () => {
    const many = Array.from({ length: MAX_WRITES_PER_RUN + 25 }, (_, i) => live(`M${i}`, 59.99));
    const sources = new Map(many.map((v) => [v.sku, src(59.99, [step(72.99, 59.99, 10)])] as const));
    const filler = Array.from({ length: 600 }, (_, i) => live(`F${i}`, 20));
    const { deps } = makeDeps({ mode: "live", live: [...filler, ...many], sources });
    const r = await runCompareAtSync({ deps });
    expect(r.applied).toBe(MAX_WRITES_PER_RUN);
    expect(r.deferred).toBe(25);
  });
});

describe("parseCompareAtMode", () => {
  it("defaults to off for anything unknown", () => {
    expect(parseCompareAtMode(null)).toBe("off");
    expect(parseCompareAtMode("yes")).toBe("off");
    expect(parseCompareAtMode("dry")).toBe("dry");
    expect(parseCompareAtMode("live")).toBe("live");
  });
});
