import { describe, it, expect } from "vitest";
import { planStockActions, assertFeedComplete, type StockBaselineRow } from "@/lib/stock-reconcile";

const NOW = 1_750_000_000; // fixed epoch
const DAY = 86400;
const row = (sku: string, qty: number, pid: string, lastSeenAt = NOW): StockBaselineRow => ({
  sku, qty, shopifyProductId: pid, lastSeenAt,
});
const csv = (entries: Array<[string, number]>) => new Map<string, number>(entries);

describe("planStockActions — availability flips (present in feed)", () => {
  it("flags going out of stock (was sellable, CSV qty<=5)", () => {
    const plan = planStockActions({
      baseline: [row("A-1", 20, "P1")], csvQtyBySku: csv([["A-1", 0]]), nowEpoch: NOW,
    });
    expect(plan.actions).toEqual([
      { shopifyProductId: "P1", skus: ["A-1"], action: "oos", targetInStock: false, restockSkus: [] },
    ]);
    expect(plan.counts.wentOOS).toBe(1);
    // baseline refreshed to the new qty for the flipped product
    expect(plan.qtyUpdates).toEqual([{ sku: "A-1", qty: 0 }]);
  });

  it("flags a restock (was sold out, CSV qty>5) and lists the sellable SKUs for the waitlist", () => {
    const plan = planStockActions({
      baseline: [row("A-1", 0, "P1")], csvQtyBySku: csv([["A-1", 20]]), nowEpoch: NOW,
    });
    expect(plan.actions[0]).toMatchObject({ action: "restock", targetInStock: true, restockSkus: ["A-1"] });
    expect(plan.counts.restocked).toBe(1);
    expect(plan.qtyUpdates).toEqual([{ sku: "A-1", qty: 20 }]);
  });

  it("no action when availability is unchanged (stays in stock / stays out)", () => {
    const stayIn = planStockActions({ baseline: [row("A-1", 20, "P1")], csvQtyBySku: csv([["A-1", 15]]), nowEpoch: NOW });
    const stayOut = planStockActions({ baseline: [row("B-1", 0, "P2")], csvQtyBySku: csv([["B-1", 3]]), nowEpoch: NOW });
    expect(stayIn.actions).toEqual([]);
    expect(stayOut.actions).toEqual([]);
    expect(stayIn.qtyUpdates).toEqual([]); // stable product never churns the DB
  });

  it("uses the buffered threshold (qty<=5 sold out, qty>5 sellable) at the boundary", () => {
    // 5 -> buffered 0 (out); was in -> oos
    expect(planStockActions({ baseline: [row("A", 20, "P1")], csvQtyBySku: csv([["A", 5]]), nowEpoch: NOW }).actions[0].action).toBe("oos");
    // 6 -> buffered 3 (in); was out -> restock
    expect(planStockActions({ baseline: [row("A", 0, "P1")], csvQtyBySku: csv([["A", 6]]), nowEpoch: NOW }).actions[0].action).toBe("restock");
  });
});

describe("planStockActions — multi-variant (product-level)", () => {
  it("a product with ANY sellable variant is in stock", () => {
    // both variants drop, but only when ALL are <=5 does the product go OOS
    const partial = planStockActions({
      baseline: [row("A-1", 20, "P1"), row("A-2", 20, "P1")],
      csvQtyBySku: csv([["A-1", 0], ["A-2", 30]]), nowEpoch: NOW,
    });
    expect(partial.actions).toEqual([]); // A-2 still sellable -> product stays in stock

    const allOut = planStockActions({
      baseline: [row("A-1", 20, "P1"), row("A-2", 20, "P1")],
      csvQtyBySku: csv([["A-1", 0], ["A-2", 2]]), nowEpoch: NOW,
    });
    expect(allOut.actions[0].action).toBe("oos");
    // both variants' new qty written back
    expect(allOut.qtyUpdates).toEqual([{ sku: "A-1", qty: 0 }, { sku: "A-2", qty: 2 }]);
  });

  it("restock restockSkus only includes the variants that are actually sellable", () => {
    const plan = planStockActions({
      baseline: [row("A-1", 0, "P1"), row("A-2", 0, "P1")],
      csvQtyBySku: csv([["A-1", 50], ["A-2", 2]]), nowEpoch: NOW,
    });
    expect(plan.actions[0]).toMatchObject({ action: "restock", restockSkus: ["A-1"] });
  });
});

describe("planStockActions — discontinued sweep (absent from feed)", () => {
  it("drafts a sold-out product that has been gone from the feed > 7 days", () => {
    const plan = planStockActions({
      baseline: [row("A-1", 0, "P1", NOW - 8 * DAY)], csvQtyBySku: csv([]), nowEpoch: NOW,
    });
    expect(plan.actions).toEqual([
      { shopifyProductId: "P1", skus: ["A-1"], action: "draft", targetInStock: false, restockSkus: [] },
    ]);
    expect(plan.counts.drafted).toBe(1);
    expect(plan.qtyUpdates).toEqual([]); // absent product contributes no baseline write
  });

  it("does NOT draft when last seen within the stale window", () => {
    const plan = planStockActions({
      baseline: [row("A-1", 0, "P1", NOW - 3 * DAY)], csvQtyBySku: csv([]), nowEpoch: NOW,
    });
    expect(plan.actions).toEqual([]);
  });

  it("does NOT draft an absent product that still had stock (decision 1: qty=0 only)", () => {
    const plan = planStockActions({
      baseline: [row("A-1", 40, "P1", NOW - 30 * DAY)], csvQtyBySku: csv([]), nowEpoch: NOW,
    });
    expect(plan.actions).toEqual([]);
  });

  it("respects a custom staleDays", () => {
    const base = { baseline: [row("A-1", 0, "P1", NOW - 5 * DAY)], csvQtyBySku: csv([]), nowEpoch: NOW };
    expect(planStockActions({ ...base, staleDays: 7 }).actions).toEqual([]); // 5d < 7d
    expect(planStockActions({ ...base, staleDays: 3 }).actions[0].action).toBe("draft"); // 5d > 3d
  });
});

describe("assertFeedComplete — truncated-feed guard", () => {
  const base = [row("A", 0, "P1"), row("B", 0, "P2"), row("C", 0, "P3"), row("D", 0, "P4"), row("E", 0, "P5")];

  it("passes when the feed covers >= 80% of imported SKUs", () => {
    // 4 of 5 present = 80%
    expect(() => assertFeedComplete(csv([["A", 1], ["B", 1], ["C", 1], ["D", 1]]), base)).not.toThrow();
  });

  it("throws (no plan) when the feed covers < 80% of imported SKUs", () => {
    // 3 of 5 = 60%
    expect(() => assertFeedComplete(csv([["A", 1], ["B", 1], ["C", 1]]), base)).toThrow(/truncated/i);
    // an empty feed against a non-empty catalog is the worst case
    expect(() => assertFeedComplete(csv([]), base)).toThrow(/truncated/i);
  });

  it("never throws on an empty baseline (nothing imported yet)", () => {
    expect(() => assertFeedComplete(csv([]), [])).not.toThrow();
  });
});

describe("planStockActions — grouping & counts", () => {
  it("groups variants by Shopify product id and counts per outcome", () => {
    const plan = planStockActions({
      baseline: [
        row("OOS-1", 20, "P1"),                  // -> oos
        row("BACK-1", 0, "P2"),                  // -> restock
        row("STABLE-1", 20, "P3"),               // -> none
        row("GONE-1", 0, "P4", NOW - 10 * DAY),  // -> draft (absent + stale + sold out)
      ],
      csvQtyBySku: csv([["OOS-1", 0], ["BACK-1", 99], ["STABLE-1", 25]]),
      nowEpoch: NOW,
    });
    expect(plan.counts).toEqual({ products: 4, wentOOS: 1, restocked: 1, drafted: 1 });
    const byPid = Object.fromEntries(plan.actions.map((a) => [a.shopifyProductId, a.action]));
    expect(byPid).toEqual({ P1: "oos", P2: "restock", P4: "draft" });
  });
});
