import { describe, it, expect, vi } from "vitest";
import {
  computePriceFloorViolations,
  correctViolations,
  persistPriceAudit,
  runPriceAuditAndCorrect,
  type PriceAuditItem,
  type AuditAndCorrectResult,
} from "@/lib/price-audit";
import * as db from "@/lib/database";
import * as shopify from "@/lib/shopify-client";

const aosom = (entries: [string, number][]) => new Map<string, number>(entries);

describe("computePriceFloorViolations", () => {
  it("flags variants priced strictly below the Aosom floor, worst gap first", () => {
    const floor = aosom([["A", 100], ["B", 50], ["C", 200]]);
    const variants = [
      { sku: "A", price: 90 },   // below by 10
      { sku: "B", price: 49.5 }, // below by 0.50
      { sku: "C", price: 250 },  // above floor → ok
    ];
    const r = computePriceFloorViolations(floor, variants);
    expect(r.total).toBe(3);
    expect(r.below_floor).toBe(2);
    expect(r.items.map((i) => i.sku)).toEqual(["A", "B"]); // -10 sorts before -0.50
    expect(r.items[0]).toEqual({ sku: "A", shopify_price: 90, aosom_price: 100, gap: -10 });
    expect(r.items[1].gap).toBe(-0.5);
  });

  it("treats an exact-match price as at-floor, NOT below (force-pushed normal state)", () => {
    const r = computePriceFloorViolations(aosom([["A", 100]]), [{ sku: "A", price: 100 }]);
    expect(r.total).toBe(1);
    expect(r.below_floor).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("rounds to cents so float noise on equal prices is not a violation", () => {
    // 19.99 stored as a float can compare just under; rounding to cents keeps it at-floor.
    const r = computePriceFloorViolations(aosom([["A", 19.99]]), [{ sku: "A", price: 0.07 + 19.92 }]);
    expect(r.below_floor).toBe(0);
  });

  it("ignores SKUs not present in the Aosom catalog, blank SKUs, and zero/negative floors", () => {
    const floor = aosom([["A", 100], ["Z", 0]]);
    const variants = [
      { sku: "GHOST", price: 1 }, // not in catalog → skipped
      { sku: "", price: 1 },      // blank sku → skipped
      { sku: "Z", price: 1 },     // floor 0 → not auditable → skipped
      { sku: "A", price: 99 },    // below → counted
    ];
    const r = computePriceFloorViolations(floor, variants);
    expect(r.total).toBe(1);
    expect(r.below_floor).toBe(1);
    expect(r.items[0].sku).toBe("A");
  });

  it("counts each SKU once even if Shopify returns a duplicate variant", () => {
    const r = computePriceFloorViolations(aosom([["A", 100]]), [
      { sku: "A", price: 80 },
      { sku: "A", price: 70 }, // duplicate sku → ignored
    ]);
    expect(r.total).toBe(1);
    expect(r.below_floor).toBe(1);
    expect(r.items[0].shopify_price).toBe(80); // first wins
  });

  it("is empty when there is nothing to compare", () => {
    expect(computePriceFloorViolations(aosom([]), [])).toEqual({ total: 0, below_floor: 0, items: [] });
  });

  it("carries the variant id through to below-floor items (needed for the correction push)", () => {
    const r = computePriceFloorViolations(aosom([["A", 100]]), [{ sku: "A", price: 80, variantId: "v1" }]);
    expect(r.items[0].variantId).toBe("v1");
  });
});

describe("correctViolations", () => {
  const item = (over: Partial<PriceAuditItem> = {}): PriceAuditItem => ({
    sku: "A", shopify_price: 80, aosom_price: 100, gap: -20, variantId: "v1", ...over,
  });

  it("pushes the floor price and records an applied floor_correction on success", async () => {
    const pushPrice = vi.fn().mockResolvedValue(undefined);
    const recordCorrection = vi.fn().mockResolvedValue(undefined);
    const out = await correctViolations([item()], { pushPrice, recordCorrection });

    expect(pushPrice).toHaveBeenCalledWith("v1", 100, 80); // (variantId, floor, oldPrice)
    expect(recordCorrection).toHaveBeenCalledWith({ sku: "A", oldPrice: 80, newPrice: 100, applied: true });
    expect(out[0]).toMatchObject({ sku: "A", status: "corrected", corrected_price: 100 });
  });

  it("marks failed (applied:false) and keeps the error when the Shopify push throws", async () => {
    const pushPrice = vi.fn().mockRejectedValue(new Error("429 rate limit"));
    const recordCorrection = vi.fn().mockResolvedValue(undefined);
    const out = await correctViolations([item()], { pushPrice, recordCorrection });

    expect(recordCorrection).toHaveBeenCalledWith({ sku: "A", oldPrice: 80, newPrice: 100, applied: false });
    expect(out[0]).toMatchObject({ status: "failed", error: "429 rate limit" });
  });

  it("fails without pushing when the violation has no variant id", async () => {
    const pushPrice = vi.fn();
    const recordCorrection = vi.fn().mockResolvedValue(undefined);
    const out = await correctViolations([item({ variantId: undefined })], { pushPrice, recordCorrection });

    expect(pushPrice).not.toHaveBeenCalled();
    expect(recordCorrection).toHaveBeenCalledWith({ sku: "A", oldPrice: 80, newPrice: 100, applied: false });
    expect(out[0]).toMatchObject({ status: "failed", error: "missing Shopify variant id", variantId: null });
  });

  it("does NOT downgrade a successful push to failed when the history write throws", async () => {
    const pushPrice = vi.fn().mockResolvedValue(undefined);
    const recordCorrection = vi.fn().mockRejectedValue(new Error("DB down"));
    const out = await correctViolations([item()], { pushPrice, recordCorrection });
    expect(out[0].status).toBe("corrected"); // live store is what matters
  });
});

describe("persistPriceAudit", () => {
  it("persists counts and surfaces failed corrections first in the capped top-N", async () => {
    const db = await import("@/lib/database");
    const setSetting = vi.spyOn(db, "setSetting").mockResolvedValue(undefined);

    const result: AuditAndCorrectResult = {
      total: 5,
      below_floor: 2,
      items: [],
      corrected: 1,
      failed: 1,
      deferred: 0,
      corrections: [
        { sku: "OK", variantId: "v1", shopify_price: 80, aosom_price: 100, corrected_price: 100, status: "corrected" },
        { sku: "BAD", variantId: "v2", shopify_price: 70, aosom_price: 90, corrected_price: 90, status: "failed", error: "boom" },
      ],
    };
    await persistPriceAudit(result, 1_700_000_000);

    const [key, json] = setSetting.mock.calls[0];
    expect(key).toBe("price_audit_result");
    const saved = JSON.parse(json as string);
    expect(saved).toMatchObject({ total: 5, belowFloor: 2, corrected: 1, failed: 1, auditedAt: 1_700_000_000 });
    expect(saved.topItems[0]).toMatchObject({ sku: "BAD", status: "failed", error: "boom" }); // failed first
    expect(saved.topItems[1]).toMatchObject({ sku: "OK", status: "corrected" });
    setSetting.mockRestore();
  });
});

describe("runPriceAuditAndCorrect", () => {
  it("caps corrections per run, pushes the worst gaps first, and defers the rest", async () => {
    vi.spyOn(db, "getProductsForPriceAudit").mockResolvedValue([
      { sku: "A", price: 100 }, { sku: "B", price: 100 }, { sku: "C", price: 100 },
    ]);
    vi.spyOn(shopify, "fetchAllShopifyProducts").mockResolvedValue([
      { variants: [
        { sku: "A", price: 90, variantId: "vA" }, // gap -10
        { sku: "B", price: 50, variantId: "vB" }, // gap -50 (worst)
        { sku: "C", price: 70, variantId: "vC" }, // gap -30
      ] },
    ] as unknown as Awaited<ReturnType<typeof shopify.fetchAllShopifyProducts>>);
    const push = vi.spyOn(shopify, "updateShopifyVariantPrice").mockResolvedValue(undefined);
    vi.spyOn(db, "recordFloorCorrection").mockResolvedValue(undefined);

    const res = await runPriceAuditAndCorrect(2); // cap = 2

    expect(res.below_floor).toBe(3);
    expect(res.corrected).toBe(2);
    expect(res.deferred).toBe(1);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls.map((c) => c[0])).toEqual(["vB", "vC"]); // worst two, worst first
    vi.restoreAllMocks();
  });
});
