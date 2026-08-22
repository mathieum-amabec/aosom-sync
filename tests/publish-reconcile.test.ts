import { describe, it, expect } from "vitest";
import {
  computePublishReconcile,
  PUBLISH_WRITE_CAP,
  type PublishReconcileRow,
  type ShopifyPublishState,
} from "@/lib/publish-reconcile";

const row = (sku: string, pid: string): PublishReconcileRow => ({ sku, shopifyProductId: pid });
const csv = (entries: Array<[string, number]>) => new Map<string, number>(entries);
const states = (entries: Array<[string, ShopifyPublishState]>) => new Map(entries);
const st = (
  status: ShopifyPublishState["status"],
  published: boolean,
  tags: string[] = [],
): ShopifyPublishState => ({ status, published, tags });

// stockBufferQty: qty<=10 -> 0 (sold out), else qty-3. So qty>10 is sellable; 10 is not.
const SELLABLE = 20;
const SOLD_OUT = 10;

describe("computePublishReconcile — publish targets", () => {
  it("publishes an active-but-unpublished product sellable in the feed", () => {
    const plan = computePublishReconcile({
      baseline: [row("A-1", "P1")],
      csvQtyBySku: csv([["A-1", SELLABLE]]),
      stateById: states([["P1", st("active", false)]]),
    });
    expect(plan.actions).toEqual([{ shopifyProductId: "P1", skus: ["A-1"], action: "publish" }]);
    expect(plan.counts.publish).toBe(1);
    expect(plan.counts.activatePublish).toBe(0);
  });

  it("activates + publishes an untagged draft sellable in the feed", () => {
    const plan = computePublishReconcile({
      baseline: [row("B-1", "P2")],
      csvQtyBySku: csv([["B-1", SELLABLE]]),
      stateById: states([["P2", st("draft", false)]]),
    });
    expect(plan.actions).toEqual([{ shopifyProductId: "P2", skus: ["B-1"], action: "activate_publish" }]);
    expect(plan.counts.activatePublish).toBe(1);
  });

  it("groups multiple variants of one product into a single action", () => {
    const plan = computePublishReconcile({
      baseline: [row("C-1", "P3"), row("C-2", "P3")],
      csvQtyBySku: csv([["C-1", 0], ["C-2", SELLABLE]]), // any sellable variant qualifies
      stateById: states([["P3", st("active", false)]]),
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ shopifyProductId: "P3", action: "publish" });
    expect(plan.actions[0].skus.sort()).toEqual(["C-1", "C-2"]);
  });
});

describe("computePublishReconcile — exclusions", () => {
  it("skips a draft carrying the auto-drafted marker (intentional aosom-sync draft)", () => {
    const plan = computePublishReconcile({
      baseline: [row("D-1", "P4")],
      csvQtyBySku: csv([["D-1", SELLABLE]]),
      stateById: states([["P4", st("draft", false, ["auto-drafted"])]]),
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.counts.skippedAutoDrafted).toBe(1);
  });

  it("skips a product tagged exclude-stale (operator opt-out), case-insensitively", () => {
    const plan = computePublishReconcile({
      baseline: [row("E-1", "P5")],
      csvQtyBySku: csv([["E-1", SELLABLE]]),
      stateById: states([["P5", st("active", false, ["Exclude-Stale"])]]),
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.counts.skippedExcludeStale).toBe(1);
  });

  it("skips a product not sellable in the current feed (buffered sold out)", () => {
    const plan = computePublishReconcile({
      baseline: [row("F-1", "P6")],
      csvQtyBySku: csv([["F-1", SOLD_OUT]]),
      stateById: states([["P6", st("active", false)]]),
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.counts.candidates).toBe(0);
  });

  it("skips a product absent from the current feed", () => {
    const plan = computePublishReconcile({
      baseline: [row("G-1", "P7")],
      csvQtyBySku: csv([]), // not in today's CSV
      stateById: states([["P7", st("active", false)]]),
    });
    expect(plan.actions).toHaveLength(0);
  });

  it("takes no action on an already-live product (active + published)", () => {
    const plan = computePublishReconcile({
      baseline: [row("H-1", "P8")],
      csvQtyBySku: csv([["H-1", SELLABLE]]),
      stateById: states([["P8", st("active", true)]]),
    });
    expect(plan.actions).toHaveLength(0);
  });

  it("skips archived and unknown (deleted) products", () => {
    const plan = computePublishReconcile({
      baseline: [row("I-1", "P9"), row("J-1", "P10")],
      csvQtyBySku: csv([["I-1", SELLABLE], ["J-1", SELLABLE]]),
      stateById: states([["P9", st("archived", false)]]), // P10 missing entirely
    });
    expect(plan.actions).toHaveLength(0);
  });
});

describe("computePublishReconcile — write cap", () => {
  it("caps actions at writeCap and reports the rest as deferred", () => {
    const baseline = Array.from({ length: 5 }, (_, i) => row(`K-${i}`, `Q${i}`));
    const stateById = states(baseline.map((r) => [r.shopifyProductId, st("active", false)] as const));
    const csvQtyBySku = csv(baseline.map((r) => [r.sku, SELLABLE] as [string, number]));
    const plan = computePublishReconcile({ baseline, csvQtyBySku, stateById, writeCap: 2 });
    expect(plan.actions).toHaveLength(2);
    expect(plan.counts.candidates).toBe(5); // pre-cap total that matched all rules
    expect(plan.counts.publish).toBe(2); // emitted actions after cap
    expect(plan.counts.deferred).toBe(3);
  });

  it("defaults the cap to PUBLISH_WRITE_CAP", () => {
    expect(PUBLISH_WRITE_CAP).toBe(67);
  });
});
