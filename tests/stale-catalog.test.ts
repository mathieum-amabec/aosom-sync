import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeStaleDrafts } from "@/lib/stale-catalog";

describe("computeStaleDrafts", () => {
  // One row per PRODUCT now (every sibling SKU past the window), not per SKU — see
  // getStaleImportedProducts and the 2026-09-30 multi-variant over-draft fix.
  const stale = [
    { shopify_product_id: "1", skus: ["A"] }, // active → draft
    { shopify_product_id: "2", skus: ["B"] }, // already draft → skip
    { shopify_product_id: "3", skus: ["C"] }, // archived → skip
    { shopify_product_id: "4", skus: ["D"] }, // not on Shopify (deleted) → failed
    { shopify_product_id: "5", skus: ["E1", "E2"] }, // active but draft write throws → failed
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

  it("drafts the whole product once, even with several stale siblings — never once per SKU", async () => {
    // Regression for the pre-2026-09-30 bug: one row per SKU meant a product with N stale
    // variants issued N draft writes and over-counted `drafted` against the cap.
    const drafted: string[] = [];
    const r = await computeStaleDrafts(
      [{ shopify_product_id: "9", skus: ["X1", "X2", "X3"] }],
      new Map([["9", "active"]]),
      async (id) => { drafted.push(id); },
      0,
    );
    expect(drafted).toEqual(["9"]); // one write, not three
    expect(r).toEqual({ stale: 1, drafted: 1, skipped: 0, excluded: 0, failed: 0, deferred: 0 });
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
    Array.from({ length: n }, (_, i) => ({ shopify_product_id: String(i), skus: [`S${i}`] }));
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

// ─── runStaleCatalogDraft — reconciliation wiring (2026-09-30) ───
//
// The 30-day sweep only ever sees a product through products.shopify_product_id. A past
// import that left that link unset (or pointing at a deleted/recreated product) was invisible
// to it forever — 193 products affected in production, accumulating since April. These lock
// that the daily run now repairs the link FIRST, using the same Shopify fetch it already pages,
// before it ever computes stale candidates — see reconcileProductShopifyLinks in database.ts.

vi.mock("@/lib/database", () => ({
  getStaleImportedProducts: vi.fn(),
  reconcileProductShopifyLinks: vi.fn(),
}));
vi.mock("@/lib/shopify-client", () => ({
  fetchAllShopifyProducts: vi.fn(),
  updateShopifyProduct: vi.fn(),
}));

describe("runStaleCatalogDraft — reconciliation wiring", () => {
  const product = (over: Partial<{ shopifyId: string; handle: string; status: string; tags: string[]; skus: string[] }> = {}) => ({
    shopifyId: over.shopifyId ?? "1",
    handle: over.handle ?? "my-product",
    status: over.status ?? "active",
    tags: over.tags ?? [],
    variants: (over.skus ?? ["SKU-1"]).map((sku) => ({ sku })),
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it("reconciles links before computing stale candidates, and surfaces the count", async () => {
    const dbMod = await import("@/lib/database");
    const shopifyMod = await import("@/lib/shopify-client");
    const live = [product({ shopifyId: "1", skus: ["SKU-1", "SKU-2"] })];
    vi.mocked(shopifyMod.fetchAllShopifyProducts).mockResolvedValue(live as never);
    vi.mocked(dbMod.reconcileProductShopifyLinks).mockResolvedValue(2);
    vi.mocked(dbMod.getStaleImportedProducts).mockResolvedValue([]);

    const { runStaleCatalogDraft } = await import("@/lib/stale-catalog");
    const result = await runStaleCatalogDraft();

    expect(dbMod.reconcileProductShopifyLinks).toHaveBeenCalledWith([
      { shopifyId: "1", handle: "my-product", skus: ["SKU-1", "SKU-2"] },
    ]);
    // reconcile must run (and its input built) BEFORE the stale query, so a link it just
    // fixed is visible to getStaleImportedProducts in the very same run.
    const reconcileOrder = vi.mocked(dbMod.reconcileProductShopifyLinks).mock.invocationCallOrder[0];
    const staleOrder = vi.mocked(dbMod.getStaleImportedProducts).mock.invocationCallOrder[0];
    expect(reconcileOrder).toBeLessThan(staleOrder);
    expect(result).toEqual({ stale: 0, drafted: 0, skipped: 0, excluded: 0, failed: 0, deferred: 0, relinked: 2 });
  });

  it("passes the relinked count through even when there are stale candidates to draft", async () => {
    const dbMod = await import("@/lib/database");
    const shopifyMod = await import("@/lib/shopify-client");
    vi.mocked(shopifyMod.fetchAllShopifyProducts).mockResolvedValue([product({ shopifyId: "1" })] as never);
    vi.mocked(shopifyMod.updateShopifyProduct).mockResolvedValue(undefined as never);
    vi.mocked(dbMod.reconcileProductShopifyLinks).mockResolvedValue(7);
    vi.mocked(dbMod.getStaleImportedProducts).mockResolvedValue([{ shopify_product_id: "1", skus: ["SKU-1"] }]);

    const { runStaleCatalogDraft } = await import("@/lib/stale-catalog");
    const result = await runStaleCatalogDraft();

    expect(result).toEqual({ stale: 1, drafted: 1, skipped: 0, excluded: 0, failed: 0, deferred: 0, relinked: 7 });
  });
});
