import { describe, it, expect, vi } from "vitest";
import { syncFitDims } from "@/lib/fit-dims-sync";
import type { AosomProduct } from "@/types/aosom";

const feedRow = (sku: string, l: string, w: string, h: string, box = "50x20x10 cm") =>
  ({ sku, dimensionsRaw: { length: l, width: w, height: h }, boxSize: box }) as unknown as AosomProduct;

const none = async () => new Map<string, string>();

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
    const dry = await syncFitDims({}, { feed, gql: first.gql, supplierBodies: none });
    expect(dry).toMatchObject({ dryRun: true, toWrite: 2, noFeedMatch: 1, pageSizeConflict: 1, written: 0 });
    expect(first.writes).toEqual([]);

    const applied = await syncFitDims({ apply: true }, { feed, gql: first.gql, supplierBodies: none });
    expect(applied.written).toBe(2);
    expect(first.writes.map((w) => w.ownerId)).toEqual(["gid://p/1", "gid://p/2"]);

    // Next day: same values already stored → nothing to write.
    const again = fakeShopify([
      { id: "gid://p/1", handle: "new-desk", skus: ["A"], current: first.writes[0].value },
      { id: "gid://p/2", handle: "gazebo", skus: ["B"], current: first.writes[1].value },
    ]);
    const r = await syncFitDims({ apply: true }, { feed, gql: again.gql, supplierBodies: none });
    expect(r).toMatchObject({ toWrite: 0, unchanged: 2, written: 0 });
  });

  it("re-reads a feed value whose unit label is wrong when a variant title states the true cm size", async () => {
    // Feed says "40.6" with a cm unit but it is really inches; the variant title states the true cm size.
    const feed = async () => [feedRow("K", "40.60 cm", "28.00 cm", "27.20 cm")];
    const s = fakeShopify([
      { id: "gid://p/9", handle: "compost-bin", skus: ["K"], variantTitle: "Noir / 103 x 71 x 69 cm", current: '{"v":1,"s":{"K":{"p":[40.6,28,27.2]}}}' },
    ]);
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql, supplierBodies: none });
    expect(r).toMatchObject({ toWrite: 1, written: 1, pageSizeConflict: 0, removed: 0 });
    expect(JSON.parse(s.writes[0].value).s.K.p).toEqual([103.1, 71.1, 69.1]);
  });

  it("removes a stored value the page contradicts when no unit slip explains it", async () => {
    const feed = async () => [feedRow("K", "40.60 cm", "28.00 cm", "27.20 cm")];
    const s = fakeShopify([
      { id: "gid://p/9", handle: "compost-bin", skus: ["K"], variantTitle: "Noir / 103 x 71 x 12 cm", current: '{"v":1,"s":{"K":{"p":[40.6,28,27.2]}}}' },
    ]);
    const dry = await syncFitDims({}, { feed, gql: s.gql, supplierBodies: none });
    expect(dry).toMatchObject({ toWrite: 0, pageSizeConflict: 1, staleToRemove: 1, removed: 0 });
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql, supplierBodies: none });
    expect(r.removed).toBe(1);
    expect(s.deletes.map((d) => d.ownerId)).toEqual(["gid://p/9"]);
    expect(s.writes).toEqual([]);
  });

  it('a 6x3x2m tunnel greenhouse read as 49 x 25 x 17 cm is re-read as feet', async () => {
    const feed = async () => [feedRow("K", "19.50 in", "9.80 in", "6.90 in", "155x40x30 cm")];
    const s = fakeShopify([
      { id: "gid://p/7", handle: "tunnel", skus: ["K"], variantTitle: "Blanc / 6x3x2m", current: '{"v":1,"s":{"K":{"p":[49.5,24.9,17.5]}}}' },
    ]);
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql, supplierBodies: none });
    expect(JSON.parse(s.writes[0].value).s.K.p.map(Math.round)).toEqual([594, 299, 210]);
    expect(r.removed).toBe(0);
  });

  it("deletes nothing when the feed row has no parseable size at all (blank columns)", async () => {
    const feed = async () => [feedRow("K", "", "", "")];
    const s = fakeShopify([{ id: "gid://p/5", handle: "blank", skus: ["K"], current: '{"v":1,"s":{"K":{"p":[40,30,20]}}}' }]);
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql, supplierBodies: none });
    expect(r).toMatchObject({ removed: 0, staleToRemove: 0 });
    expect(s.deletes).toEqual([]);
  });

  it("caps deletions per run", async () => {
    const feed = async () => Array.from({ length: 130 }, (_, i) => feedRow(`D${i}`, "40.60 cm", "28.00 cm", "27.20 cm"));
    const s = fakeShopify(Array.from({ length: 130 }, (_, i) => ({ id: `gid://p/${i}`, handle: `p${i}`, skus: [`D${i}`], variantTitle: "Noir / 103 x 71 x 12 cm", current: '{"v":1,"s":{"X":{"p":[1,1,1]}}}' })));
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql, supplierBodies: none });
    expect(r.removed).toBe(100);
    expect(r.staleToRemove).toBe(130);
  });

  it("caps writes per run and reports the rest as deferred", async () => {
    const feed = async () => Array.from({ length: 30 }, (_, i) => feedRow(`S${i}`, "10 in", "10 in", "10 in"));
    const s = fakeShopify(Array.from({ length: 30 }, (_, i) => ({ id: `gid://p/${i}`, handle: `p${i}`, skus: [`S${i}`] })));
    const r = await syncFitDims({ apply: true, limit: 10 }, { feed, gql: s.gql, supplierBodies: none });
    expect(r).toMatchObject({ written: 10, deferred: 20 });
  });

  it("fills a Costway product (no feed row) from the supplier description, never one that already has a value", async () => {
    const feed = async () => [];
    const body = "<p>● Shipped in 3 Boxes: The overall dimension of the sofa: is 94.5” x 32.5” x 32.5” (L x W x H)</p>";
    const bodies = vi.fn(async (skus: string[]) => new Map(skus.filter((k) => k !== "NONE").map((k) => [k, body])));
    const s = fakeShopify([
      { id: "gid://p/c1", handle: "canape", skus: ["MAAA", "MBBB"] },
      { id: "gid://p/c2", handle: "deja-rempli", skus: ["MCCC"], current: '{"v":1,"s":{"MCCC":{"p":[1,2,3]}}}' },
      { id: "gid://p/c3", handle: "sans-texte", skus: ["NONE"] },
    ]);
    const r = await syncFitDims({ apply: true }, { feed, gql: s.gql, supplierBodies: bodies });
    expect(r).toMatchObject({ noFeedMatch: 3, fromSupplierText: 1, written: 1, removed: 0 });
    expect(bodies).toHaveBeenCalledWith(["MAAA", "MBBB", "NONE"]);
    expect(s.writes).toEqual([{ ownerId: "gid://p/c1", namespace: "custom", key: "lc_dims", type: "json", value: '{"v":1,"s":{"MAAA":{"p":[240,82.6,82.6]},"MBBB":{"p":[240,82.6,82.6]}}}' }]);
    expect(s.deletes).toEqual([]);
  });

  it("drops a supplier size the product page contradicts", async () => {
    const s = fakeShopify([{ id: "gid://p/c4", handle: "table", skus: ["MT"], description: "Dimensions : 10 x 10 x 10 cm" }]);
    const bodies = async () => new Map([["MT", "Overall Dimensions: 31\" x 16\" x 13\" (L x W x H)"]]);
    const r = await syncFitDims({ apply: true }, { feed: async () => [], gql: s.gql, supplierBodies: bodies });
    expect(r).toMatchObject({ fromSupplierText: 0, pageSizeConflict: 1, written: 0 });
  });
});
