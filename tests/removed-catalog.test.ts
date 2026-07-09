import { describe, it, expect, vi } from "vitest";
import {
  planRemovedFromFeed,
  isRenameSuspect,
  runRemovedFromFeedDraft,
  MIN_ACTIVE_COVERAGE,
  type RemovedPlanInput,
} from "@/lib/removed-catalog";
import type { ShopifyExistingProduct, ShopifyExistingVariant } from "@/types/sync";

// ─── builders ───────────────────────────────────────────────────────
function variant(sku: string): ShopifyExistingVariant {
  return { variantId: `v-${sku}`, sku, price: 10, inventoryQuantity: 5, inventoryItemId: `i-${sku}`, option1: null, option2: null, weight: 0, gtin: "" };
}
function product(
  shopifyId: string,
  skus: string[],
  opts: { status?: "active" | "draft" | "archived"; tags?: string[]; title?: string } = {},
): ShopifyExistingProduct {
  return {
    shopifyId, title: opts.title ?? `Product ${shopifyId}`,
    status: opts.status ?? "active", variants: skus.map(variant),
    images: [], bodyHtml: "", productType: "", tags: opts.tags ?? [],
  };
}
/** Build a plan input; feedSkus/feedSkuList derived from one uppercase list. */
function input(
  removedSkus: string[],
  feed: string[],
  shopifyProducts: ShopifyExistingProduct[],
  minActiveCoverage?: number,
): RemovedPlanInput {
  const feedSkus = new Set(feed.map((s) => s.toUpperCase()));
  return { removedSkus, feedSkus, feedSkuList: [...feedSkus], shopifyProducts, minActiveCoverage };
}

// ─── isRenameSuspect ────────────────────────────────────────────────
describe("isRenameSuspect", () => {
  it("flags a feed SKU that extends the removed base (84D-082 → 84D-082V00BG)", () => {
    expect(isRenameSuspect("84D-082", ["84D-082V00BG"])).toBe(true);
  });
  it("flags a feed base that the removed SKU extends (830-161BN → 830-161)", () => {
    expect(isRenameSuspect("830-161BN", ["830-161"])).toBe(true);
  });
  it("does not flag an unrelated SKU", () => {
    expect(isRenameSuspect("845-893V00BK", ["111-222V00BK", "845-000V00BK"])).toBe(false);
  });
  it("does not flag an exact match (that is 'present in feed', handled elsewhere)", () => {
    expect(isRenameSuspect("845-893V00BK", ["845-893V00BK"])).toBe(false);
  });
  it("ignores trivially short shared prefixes (< RENAME_MIN_LEN)", () => {
    expect(isRenameSuspect("84D", ["84D-999"])).toBe(false); // removed SKU too short
    expect(isRenameSuspect("84D-99", ["84"])).toBe(false);   // feed relative too short
  });
});

// ─── guard ──────────────────────────────────────────────────────────
describe("planRemovedFromFeed — feed completeness guard", () => {
  it("produces NO writes when active coverage < 80%", () => {
    // 5 active variants, only 3 in feed = 60% < 80% → guard trips
    const products = [
      product("P1", ["A-1"]), product("P2", ["A-2"]), product("P3", ["A-3"]),
      product("P4", ["A-4"]), product("P5", ["A-5"]),
    ];
    const plan = planRemovedFromFeed(input(["A-4", "A-5"], ["A-1", "A-2", "A-3"], products));
    expect(plan.guard.ok).toBe(false);
    expect(plan.guard.coverage).toBeCloseTo(0.6);
    expect(plan.drafts).toEqual([]);
    expect(plan.qtyZeroSkus).toEqual([]);
  });

  it("proceeds when active coverage ≥ 80% (already-drafted products excluded from denominator)", () => {
    // 8 active variants covered by feed + 2 gone = 80%. Two draft products (gone) don't
    // count against coverage.
    const active = Array.from({ length: 8 }, (_, i) => product(`P${i}`, [`A-${i}`]));
    const goneActive = product("G1", ["G-1"], { status: "active" });
    const goneActive2 = product("G2", ["G-2"], { status: "active" });
    const alreadyDraft = product("D1", ["D-1"], { status: "draft" }); // excluded from denom
    const feed = Array.from({ length: 8 }, (_, i) => `A-${i}`);
    const plan = planRemovedFromFeed(
      input(["G-1", "G-2", "D-1"], feed, [...active, goneActive, goneActive2, alreadyDraft]),
    );
    // 8 covered / 10 active variant skus = 80% → ok
    expect(plan.guard.ok).toBe(true);
    expect(plan.drafts.map((d) => d.shopifyId).sort()).toEqual(["G1", "G2"]);
  });
});

// ─── core decisions ─────────────────────────────────────────────────
describe("planRemovedFromFeed — draft + qty→0 decisions", () => {
  const filler = () => Array.from({ length: 10 }, (_, i) => product(`F${i}`, [`F-${i}`]));
  const fillerFeed = () => Array.from({ length: 10 }, (_, i) => `F-${i}`);

  it("drafts a product whose every variant is gone, and zeroes its SKUs", () => {
    const gone = product("G1", ["G-1", "G-2"], { title: "Gone Product" });
    const plan = planRemovedFromFeed(input(["G-1", "G-2"], fillerFeed(), [...filler(), gone]));
    expect(plan.drafts).toEqual([{ shopifyId: "G1", title: "Gone Product", skus: ["G-1", "G-2"] }]);
    expect(plan.qtyZeroSkus.sort()).toEqual(["G-1", "G-2"]);
  });

  it("does NOT draft a product with at least one variant still in feed", () => {
    const partial = product("P1", ["P-1", "P-2"]);
    // P-2 still in feed → product stays live
    const plan = planRemovedFromFeed(input(["P-1"], [...fillerFeed(), "P-2"], [...filler(), partial]));
    expect(plan.drafts).toEqual([]);
    // P-1 maps to a live product → still zeroed (that variant is genuinely gone)
    expect(plan.qtyZeroSkus).toEqual(["P-1"]);
  });

  it("skips exclude-stale products (no draft, no qty→0)", () => {
    const gone = product("G1", ["G-1"], { tags: ["exclude-stale"] });
    const plan = planRemovedFromFeed(input(["G-1"], fillerFeed(), [...filler(), gone]));
    expect(plan.drafts).toEqual([]);
    expect(plan.qtyZeroSkus).toEqual([]);
    expect(plan.skipped.excludeStale).toBe(1);
  });

  it("skips rename-suspects (no draft, no qty→0) but leaves the product live", () => {
    // DB "84D-082" gone, feed has "84D-082V00BG" → rename suspect
    const gone = product("G1", ["84D-082"]);
    const plan = planRemovedFromFeed(input(["84D-082"], [...fillerFeed(), "84D-082V00BG"], [...filler(), gone]));
    expect(plan.drafts).toEqual([]);
    expect(plan.qtyZeroSkus).toEqual([]);
    expect(plan.skipped.renameSuspect).toBe(1);
  });

  it("counts an already draft/archived gone product as inactive, does not re-draft", () => {
    const goneDraft = product("G1", ["G-1"], { status: "draft" });
    const plan = planRemovedFromFeed(input(["G-1"], fillerFeed(), [...filler(), goneDraft]));
    expect(plan.drafts).toEqual([]);
    expect(plan.skipped.alreadyInactive).toBe(1);
    // still zero its qty (it maps to a live variant record)
    expect(plan.qtyZeroSkus).toEqual(["G-1"]);
  });

  it("does not zero a removed SKU that maps to no Shopify variant (non-imported)", () => {
    const plan = planRemovedFromFeed(input(["ORPHAN-1"], fillerFeed(), filler()));
    expect(plan.qtyZeroSkus).toEqual([]);
  });

  it("does NOT draft a manual/non-Aosom product whose SKUs were never in the feed nor removed (F1)", () => {
    // A real removal (G-1) opens the gate, but MANUAL-1 (all variants gone from feed,
    // yet never in the DB/removed set) must be left alone — it isn't an Aosom product.
    const gone = product("G1", ["G-1"]);
    const manual = product("M1", ["MANUAL-1"], { title: "Hand-made bundle" });
    const plan = planRemovedFromFeed(input(["G-1"], fillerFeed(), [...filler(), gone, manual]));
    expect(plan.drafts.map((d) => d.shopifyId)).toEqual(["G1"]);
    expect(plan.drafts.find((d) => d.shopifyId === "M1")).toBeUndefined();
  });

  it("does not zero a removed SKU that is actually still in the feed under different case (F4)", () => {
    const gone = product("G1", ["g-1"]); // Shopify variant lower-case
    // "g-1" is in the removed list (exact-case diff) but the feed has "G-1" (upper) → still present
    const plan = planRemovedFromFeed(input(["g-1"], [...fillerFeed(), "G-1"], [...filler(), gone]));
    expect(plan.qtyZeroSkus).toEqual([]);
    expect(plan.drafts).toEqual([]);
  });

  it("is deterministic across repeated runs (idempotent plan)", () => {
    const gone = product("G1", ["G-1"]);
    const a = planRemovedFromFeed(input(["G-1"], fillerFeed(), [...filler(), gone]));
    const b = planRemovedFromFeed(input(["G-1"], fillerFeed(), [...filler(), gone]));
    expect(a).toEqual(b);
  });
});

// ─── runner (I/O wiring, injected deps) ─────────────────────────────
describe("runRemovedFromFeedDraft", () => {
  const filler = () => Array.from({ length: 10 }, (_, i) => product(`F${i}`, [`F-${i}`]));
  const fillerFeed = () => Array.from({ length: 10 }, (_, i) => `F-${i}`);

  it("no-ops with empty removed list (no fetch, no writes)", async () => {
    const fetchShopify = vi.fn();
    const res = await runRemovedFromFeedDraft([], new Set(), { fetchShopify });
    expect(res.ran).toBe(false);
    expect(fetchShopify).not.toHaveBeenCalled();
  });

  it("drafts gone products + zeroes qty via injected deps", async () => {
    const gone = product("G1", ["G-1"]);
    const draft = vi.fn().mockResolvedValue(undefined);
    const zeroQty = vi.fn().mockResolvedValue(1);
    const feedSkus = new Set(fillerFeed().map((s) => s.toUpperCase()));
    const res = await runRemovedFromFeedDraft(["G-1"], feedSkus, {
      shopifyProducts: [...filler(), gone], draft, zeroQty, rateLimitMs: 0, log: () => {},
    });
    expect(res.drafted).toBe(1);
    expect(res.qtyZeroed).toBe(1);
    expect(draft).toHaveBeenCalledWith("G1");
    expect(zeroQty).toHaveBeenCalledWith(["G-1"]);
  });

  it("returns guardTripped and writes nothing when feed looks truncated", async () => {
    const draft = vi.fn();
    const zeroQty = vi.fn();
    // 2 active variants, feed empty → 0% coverage
    const res = await runRemovedFromFeedDraft(["A-1"], new Set(), {
      shopifyProducts: [product("P1", ["A-1"]), product("P2", ["A-2"])],
      draft, zeroQty, rateLimitMs: 0, log: () => {},
    });
    expect(res.guardTripped).toBe(true);
    expect(draft).not.toHaveBeenCalled();
    expect(zeroQty).not.toHaveBeenCalled();
  });

  it("a per-product draft failure is counted, never aborts the batch", async () => {
    const g1 = product("G1", ["G-1"]);
    const g2 = product("G2", ["G-2"]);
    const draft = vi.fn()
      .mockRejectedValueOnce(new Error("shopify 500"))
      .mockResolvedValueOnce(undefined);
    const feedSkus = new Set(fillerFeed().map((s) => s.toUpperCase()));
    const res = await runRemovedFromFeedDraft(["G-1", "G-2"], feedSkus, {
      shopifyProducts: [...filler(), g1, g2], draft, zeroQty: vi.fn().mockResolvedValue(2), rateLimitMs: 0, log: () => {},
    });
    expect(res.drafted).toBe(1);
    expect(res.failed).toBe(1);
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it("MIN_ACTIVE_COVERAGE is the documented 80% threshold", () => {
    expect(MIN_ACTIVE_COVERAGE).toBe(0.8);
  });
});
