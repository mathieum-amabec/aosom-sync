import { describe, it, expect, vi } from "vitest";
import { computeStaleDrafts } from "@/lib/stale-catalog";

describe("computeStaleDrafts", () => {
  const stale = [
    { sku: "A", shopify_product_id: "1" }, // active → draft
    { sku: "B", shopify_product_id: "2" }, // already draft → skip
    { sku: "C", shopify_product_id: "3" }, // archived → skip
    { sku: "D", shopify_product_id: "4" }, // not on Shopify (deleted) → failed
    { sku: "E", shopify_product_id: "5" }, // active but draft write throws → failed
  ];
  const statusById = new Map([["1", "active"], ["2", "draft"], ["3", "archived"], ["5", "active"]]);

  it("drafts active, skips draft/archived, fails on deleted + thrown writes", async () => {
    const drafted: string[] = [];
    const draftFn = vi.fn(async (id: string) => {
      if (id === "5") throw new Error("429 rate limit");
      drafted.push(id);
    });
    const r = await computeStaleDrafts(stale, statusById, draftFn, 0);

    expect(r).toEqual({ stale: 5, drafted: 1, skipped: 2, excluded: 0, failed: 2, deferred: 0 });
    expect(drafted).toEqual(["1"]); // only the active, non-throwing product
    expect(draftFn).toHaveBeenCalledTimes(2); // active ones (1, 5); skipped/deleted never call it
  });

  it("returns zeros for an empty stale set", async () => {
    expect(await computeStaleDrafts([], new Map(), vi.fn(), 0)).toEqual({ stale: 0, drafted: 0, skipped: 0, excluded: 0, failed: 0, deferred: 0 });
  });

  it("leaves excluded (exclude-stale tagged) products live, even when active", async () => {
    const drafted: string[] = [];
    const draftFn = vi.fn(async (id: string) => {
      if (id === "5") throw new Error("429 rate limit");
      drafted.push(id);
    });
    // Product "1" is active+stale but carries the exclude-stale tag → must be left live.
    const excludedIds = new Set(["1"]);
    const r = await computeStaleDrafts(stale, statusById, draftFn, 0, excludedIds);

    expect(r).toEqual({ stale: 5, drafted: 0, skipped: 2, excluded: 1, failed: 2, deferred: 0 });
    expect(drafted).toEqual([]); // "1" excluded; "5" attempted but throws
    expect(draftFn).not.toHaveBeenCalledWith("1"); // excluded → never drafted
  });
});

// ─── WRITE_CAP — introduced with the `qty > 0` removal (2026-09-14) ───
//
// Dropping `qty > 0` from getStaleImportedProducts took the 30-day candidate list from 45 to
// 406 products against production. At 500ms a write that is ~3.4min of writes alone, inside a
// 300s cron that must also paginate the whole Shopify catalog first. The cap bounds it; these
// lock the semantics that make capping safe.

describe("computeStaleDrafts — per-run write cap", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, shopify_product_id: String(i) }));
  const allActive = (n: number) =>
    new Map(Array.from({ length: n }, (_, i) => [String(i), "active"]));

  it("stops writing at the cap and reports the rest as deferred", async () => {
    const draftFn = vi.fn(async () => {});
    const r = await computeStaleDrafts(many(400), allActive(400), draftFn, 0, new Set(), 250);

    expect(r.drafted).toBe(250);
    expect(r.deferred).toBe(150);
    expect(r.stale).toBe(400);
    expect(draftFn).toHaveBeenCalledTimes(250);
  });

  it("does not burn the cap on products that need no write", async () => {
    // 300 already-drafted + 10 active. A scan-based cap would spend itself on the 300 no-ops
    // and never reach the ones that matter; a write-based cap gets to them.
    const stale = many(310);
    const statusById = new Map(stale.map((p, i) => [p.shopify_product_id, i < 300 ? "draft" : "active"]));
    const draftFn = vi.fn(async () => {});
    const r = await computeStaleDrafts(stale, statusById, draftFn, 0, new Set(), 5);

    expect(r.skipped).toBe(300);
    expect(r.drafted).toBe(5);   // cap reached on real writes only
    expect(r.deferred).toBe(5);
  });

  it("leaves a normal under-cap run completely unaffected", async () => {
    const draftFn = vi.fn(async () => {});
    const r = await computeStaleDrafts(many(44), allActive(44), draftFn, 0, new Set(), 250);

    expect(r.drafted).toBe(44);
    expect(r.deferred).toBe(0); // the historical stale=44 behaviour is untouched
  });

  it("converges: a capped run is drained by the next one", async () => {
    const stale = many(400);
    const status = allActive(400);
    const draftFn = vi.fn(async (id: string) => { status.set(id, "draft"); });

    const r1 = await computeStaleDrafts(stale, status, draftFn, 0, new Set(), 250);
    const r2 = await computeStaleDrafts(stale, status, draftFn, 0, new Set(), 250);

    expect(r1.drafted).toBe(250);
    expect(r2.drafted).toBe(150);
    expect(r2.deferred).toBe(0);
    expect(r1.drafted + r2.drafted).toBe(400); // nothing lost, nothing drafted twice
  });
});
