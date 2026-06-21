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

    expect(r).toEqual({ stale: 5, drafted: 1, skipped: 2, excluded: 0, failed: 2 });
    expect(drafted).toEqual(["1"]); // only the active, non-throwing product
    expect(draftFn).toHaveBeenCalledTimes(2); // active ones (1, 5); skipped/deleted never call it
  });

  it("returns zeros for an empty stale set", async () => {
    expect(await computeStaleDrafts([], new Map(), vi.fn(), 0)).toEqual({ stale: 0, drafted: 0, skipped: 0, excluded: 0, failed: 0 });
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

    expect(r).toEqual({ stale: 5, drafted: 0, skipped: 2, excluded: 1, failed: 2 });
    expect(drafted).toEqual([]); // "1" excluded; "5" attempted but throws
    expect(draftFn).not.toHaveBeenCalledWith("1"); // excluded → never drafted
  });
});
