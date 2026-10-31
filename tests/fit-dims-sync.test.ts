import { describe, it, expect, vi } from "vitest";
import { syncFitDims } from "@/lib/fit-dims-sync";
import type { AosomProduct } from "@/types/aosom";

const feedRow = (sku: string, l: string, w: string, h: string, box = "50x20x10 cm") =>
  ({ sku, dimensionsRaw: { length: l, width: w, height: h }, boxSize: box }) as unknown as AosomProduct;

function fakeShopify(nodes: Array<{ id: string; handle: string; skus: string[]; description?: string; current?: string; variantTitle?: string }>) {
  const writes: Array<{ ownerId: string; value: string }> = [];
  const deletes: Array<{ ownerId: string }> = [];
  const gql = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
    if (query.includes("metafieldsSet")) {
      writes.push(...(vars!.m as Array<{ ownerId: string; value: string }>));
      return { data: { metafieldsSet: { userErrors: [] } } };
    }
    if (query.includes("metafieldsDelete")) {
      deletes.push(...(vars!.m as Array<{ ownerId: string }>));
      return { data: { metafieldsDelete: { userErrors: [] } } };
    }
    return {
      data: {
        products: {
          nodes: nodes.map((n) => ({ id: n.id, handle: n.handle, status: "ACTIVE", description: n.description ?? "", variants: { nodes: n.skus.map((sku) => ({ sku, title: n.variantTitle ?? "Default Title" })) }, metafield: n.current ? { value: n.current } : null })),
          pageInfo: { hasNextPage: false, endCursor: "" },
        },
      },
    };
  });
  return { gql: gql as never, writes, deletes };
}

describe("syncFitDims (daily safety net)", () => {
  it("writes only products missing or changed, skips no-feed and page conflicts", async () => {
    const feed = async () => [feedRow("A", "47.30 in", "19.80 in", "29.50 in"), feedRow("B", "10.00 ft", "10.00 ft", "100.00 cm"), feedRow("C", "40.00 in", "20.00 in", "30.00 in")];
    const first = fakeShopify([
      { id: "gid://p/1", handle: "new-desk", skus: ["A"] },
      { id: "gid://p/2", handle: "gazebo", skus: ["B"] },
      { id: "gid://p/3", handle: "costway", skus: ["CW-1"] },
      { id: "gid://p/4", handle: "wrong-page", skus: ["C"], description: "Dimensions: 10 x 10 x 10 cm" },
    ]);
    const dry = await syncFitDims({}, { feed, gql: first.gql });
    expect(dry).toMatchObject({ dryRun: true, toWrite: 2, noFeedMatch: 1, pageSizeConflict: 1, written: 0 });
    expect(first.writes).toEqual([]);

    const applied = await syncFitDims({ apply: true }, { feed, gql: first.gql });
    expect(applied.written).toBe(2);
    expect(first.writes.map((w) => w.ownerId)).toEqual(["gid://p/1", "gid://p/2"]);

    // Next day: same values already stored → nothing to write.
    const again = fakeShopify([
      { id: "gid://p/1", handle: "new-desk", skus: ["A"], current: first.writes[0].value },
      { id: "gid://p/2", handle: "gazebo", skus: ["B"], current: first.writes[1].value },
    ]);
    const r = await syncFitDims({ apply: true }, { feed, gql: again.gql });
    expect(r).toMatchObject({ toWrite: 0, unchanged: 2, written: 0 });
  });

  it("checks the size in variant titles too, and removes a stored value the page contradicts", async () => {
    // Feed says "40.6" with a cm unit but it is really inches; only the variant title states the true cm size.
    const feed = async () => [feedRow("K", "40.60 cm", "28.00 cm", "27.20 cm")];
    const s = fakeShopify([
      { id: "gid://p/9", handle: "compost-bin", skus: ["K"], variantTitle: "Noir / 103 x 71 x 69 cm", current: '{"v":1,"s":{"K":{"p":[40.6,28,27.2]}}}' },
    ]);
    const dry = await syncFitDims({}, { feed, gql: s.gql });
    expect(dry).toMatchObject({ toWrite: 0, pageSizeConflict: 1, staleToRemove: 1, removed: 0 });
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql });
    expect(r.removed).toBe(1);
    expect(s.deletes.map((d) => d.ownerId)).toEqual(["gid://p/9"]);
    expect(s.writes).toEqual([]);
  });

  it("caps writes per run and reports the rest as deferred", async () => {
    const feed = async () => Array.from({ length: 30 }, (_, i) => feedRow(`S${i}`, "10 in", "10 in", "10 in"));
    const s = fakeShopify(Array.from({ length: 30 }, (_, i) => ({ id: `gid://p/${i}`, handle: `p${i}`, skus: [`S${i}`] })));
    const r = await syncFitDims({ apply: true, limit: 10 }, { feed, gql: s.gql });
    expect(r).toMatchObject({ written: 10, deferred: 20 });
  });
});
