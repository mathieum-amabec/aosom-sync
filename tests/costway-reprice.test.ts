import { describe, it, expect, vi } from "vitest";
import { planReprice, runCostwayReprice, costwaySources, parseRepriceMode, MAX_PRICE_WRITES_PER_RUN, type CostwayRow, type CostwayRepriceDeps } from "@/lib/costway/reprice";
import type { LiveVariant } from "@/lib/compare-at";

const NOW = Date.UTC(2026, 9, 29, 16, 45) / 1000;
const DAY = 86_400;
const row = (internalSku: string, price: number, priceDrop: number | null = null): CostwayRow => ({ sku: `cw-${internalSku}`, internalSku, shopifyProductId: "p1", price, priceDrop, promoTag: "" });
const live = (sku: string, price: number, compareAtPrice: number | null = null): LiveVariant => ({ sku, variantId: `v-${sku}`, price, compareAtPrice });

describe("planReprice", () => {
  it("moves each variant to Costway's price and counts the rest", () => {
    const p = planReprice(
      [row("A", 99.99), row("B", 59.99), row("C", 49.99), row("D", 0)],
      new Map([["A", live("A", 108.99)], ["B", live("B", 59.99)], ["D", live("D", 10)]]),
    );
    expect(p.changes).toEqual([expect.objectContaining({ internalSku: "A", from: 108.99, to: 99.99, costwayPrice: 99.99 })]);
    expect(p.same).toBe(1);
    expect(p.missing).toBe(1);
    expect(p.invalid).toBe(1);
  });

  it("raises a price Costway raised above ours (never below Costway's price or Price Drop)", () => {
    const p = planReprice([row("A", 99.99, 102)], new Map([["A", live("A", 98.99)]]));
    expect(p.changes[0]).toMatchObject({ from: 98.99, to: 102.99 });
  });

  it("holds back a cut deeper than 50 % as a probable feed error", () => {
    const p = planReprice([row("A", 40)], new Map([["A", live("A", 120)]]));
    expect(p.changes).toHaveLength(0);
    expect(p.suspicious).toHaveLength(1);
  });
});

function deps(over: Partial<CostwayRepriceDeps> & { mode?: string; compareMode?: string; rows?: CostwayRow[]; liveVariants?: LiveVariant[] } = {}) {
  const store: Record<string, string> = { costway_reprice_mode: over.mode ?? "live", compare_at_mode: over.compareMode ?? "live", compare_at_min_days: "1" };
  const history: Array<{ sku: string; oldPrice: number | null; newPrice: number; at: number }> = [];
  const liveVariants = over.liveVariants ?? [live("A", 108.99), live("B", 59.99)];
  const d: CostwayRepriceDeps = {
    now: () => new Date(NOW * 1000),
    getSetting: async (k) => store[k] ?? null,
    setSetting: async (k, v) => { store[k] = v; },
    loadRows: async () => over.rows ?? [row("A", 89.99), row("B", 59.99)],
    loadLive: async () => liveVariants.map((v) => ({ ...v })),
    writePrice: vi.fn(async () => {}),
    recordChange: vi.fn(async (c, atS) => { history.push({ sku: c.internalSku, oldPrice: c.from, newPrice: c.to, at: atS }); }),
    loadSources: async (rows, lv) => costwaySources(rows.map((r) => ({ internalSku: r.internalSku, firstSeenAt: NOW - 12 * DAY })), lv, history),
    writeCompareAt: vi.fn(async () => {}),
    ...over,
  };
  return d;
}

describe("runCostwayReprice", () => {
  it("does nothing while off (the default)", async () => {
    expect(parseRepriceMode(null)).toBe("off");
    const d = deps({ mode: "off" });
    const r = await runCostwayReprice({ deps: d });
    expect(r.skipped).toBe("off");
    expect(d.writePrice).not.toHaveBeenCalled();
  });

  it("dry mode plans and writes nothing", async () => {
    const d = deps({ mode: "dry" });
    const r = await runCostwayReprice({ deps: d });
    expect(r.plan.changes).toHaveLength(1);
    expect(d.writePrice).not.toHaveBeenCalled();
    expect(d.writeCompareAt).not.toHaveBeenCalled();
  });

  it("writes the new price, records it, and shows the old price crossed out on a cut of 10 % or more", async () => {
    const d = deps();
    const r = await runCostwayReprice({ deps: d });
    expect(r.applied).toBe(1);
    expect(d.writePrice).toHaveBeenCalledWith("v-A", 89.99);
    expect(d.recordChange).toHaveBeenCalledTimes(1);
    expect(d.writeCompareAt).toHaveBeenCalledWith("v-A", 108.99);
    expect(d.writeCompareAt).toHaveBeenCalledTimes(1);
  });

  it("no crossed price on a cut under 10 %", async () => {
    const d = deps({ rows: [row("A", 99.99)], liveVariants: [live("A", 104.99)] });
    await runCostwayReprice({ deps: d });
    expect(d.writePrice).toHaveBeenCalledWith("v-A", 99.99);
    expect(d.writeCompareAt).not.toHaveBeenCalled();
  });

  it("a slide in small steps shows the crossed price once the total reaches 10 %", async () => {
    const history = [{ sku: "A", oldPrice: 108.99, newPrice: 102.99, at: NOW - 5 * DAY }];
    const d = deps({
      rows: [row("A", 97.99)],
      liveVariants: [live("A", 102.99)],
      loadSources: async (rows, lv) => costwaySources(rows.map((r) => ({ internalSku: r.internalSku, firstSeenAt: NOW - 12 * DAY })), lv, history),
    });
    await runCostwayReprice({ deps: d });
    expect(d.writeCompareAt).toHaveBeenCalledWith("v-A", 108.99);
  });

  it("keeps an already valid crossed price", async () => {
    const d = deps({ rows: [row("A", 89.99)], liveVariants: [live("A", 89.99, 108.99)] });
    const r = await runCostwayReprice({ deps: d });
    expect(d.writeCompareAt).not.toHaveBeenCalled();
    expect(r.compareAt?.plan.keptValid).toBe(1);
  });

  it("leaves crossed prices alone when compare_at_mode is off", async () => {
    const d = deps({ compareMode: "off" });
    const r = await runCostwayReprice({ deps: d });
    expect(r.applied).toBe(1);
    expect(r.compareAt?.skipped).toBe("off");
    expect(d.writeCompareAt).not.toHaveBeenCalled();
  });

  it("counts a failed write without stopping, and caps the writes per run", async () => {
    const rows = Array.from({ length: MAX_PRICE_WRITES_PER_RUN + 5 }, (_, i) => row(`S${i}`, 50));
    const lv = rows.map((r) => live(r.internalSku, 52));
    const writePrice = vi.fn(async (id: string) => { if (id === "v-S0") throw new Error("boom"); });
    const d = deps({ rows, liveVariants: lv, writePrice });
    const r = await runCostwayReprice({ deps: d });
    expect(r.failed).toBe(1);
    expect(r.applied).toBe(MAX_PRICE_WRITES_PER_RUN - 1);
    expect(r.deferred).toBe(5);
  });
});
