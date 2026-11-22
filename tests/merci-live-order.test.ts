import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn(), parseLinkHeader: vi.fn() }));
vi.mock("@/lib/csv-fetcher", () => ({ fetchAosomCatalog: vi.fn() }));
vi.mock("@/lib/database", () => ({ ensureSchema: vi.fn() }));

import { shopifyFetch } from "@/lib/shopify-client";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { ensureSchema } from "@/lib/database";
import { applyLive, verifyLive, liveCheckSet, supplyFrom, withTimeout, type LiveVariant } from "@/lib/post-purchase/live-check";
import { variantDisplayTitle } from "@/lib/post-purchase/catalog";
import { callerOwnsOrder, usedMerciCode, ownershipProblem } from "@/lib/post-purchase/order";
import type { MerciPick } from "@/lib/post-purchase/offer-rules";

const pick = (over: Partial<MerciPick>): MerciPick => ({
  variantId: "1", productId: "p1", sku: "A-1", source: "aosom", handle: "h", title: "Table", type: "A > B", colour: null,
  price: 60, compareAt: null, cost: 30, imageUrl: "https://cdn/old.jpg", pct: 10, why: "w", discountedPrice: 54, ...over,
});
const live = (over: Partial<LiveVariant>): LiveVariant => ({ variantId: "1", price: 60, compareAt: 79.99, title: "Table — Noir", imageUrl: "https://cdn/live.jpg", active: true, published: true, ...over });

describe("#2 applyLive — the shown price is the live (checkout) price, re-checked against today's cost", () => {
  const supply = () => ({ cost: 30, inStock: true });

  it("uses live price, compare-at, title and photo, and recomputes the tier", () => {
    const out = applyLive([pick({})], 120, new Map([["1", live({ price: 64.99 })]]), supply);
    expect(out[0]).toMatchObject({ price: 64.99, compareAt: 79.99, title: "Table — Noir", imageUrl: "https://cdn/live.jpg", pct: 10, discountedPrice: 58.5 });
  });
  it("drops a variant that went draft, unpublished or missing", () => {
    expect(applyLive([pick({})], 120, new Map([["1", live({ active: false })]]), supply)).toEqual([]);
    expect(applyLive([pick({})], 120, new Map([["1", live({ published: false })]]), supply)).toEqual([]);
    expect(applyLive([pick({})], 120, new Map(), supply)).toEqual([]);
  });
  it("drops it when out of stock or with unknown cost today", () => {
    expect(applyLive([pick({})], 120, new Map([["1", live({})]]), () => ({ cost: 30, inStock: false }))).toEqual([]);
    expect(applyLive([pick({})], 120, new Map([["1", live({})]]), () => null)).toEqual([]);
  });
  it("downgrades 10 % → 5 % or drops it when today's cost rose", () => {
    expect(applyLive([pick({})], 120, new Map([["1", live({ price: 100 })]]), () => ({ cost: 81, inStock: true }))[0].pct).toBe(5);
    expect(applyLive([pick({})], 120, new Map([["1", live({ price: 100 })]]), () => ({ cost: 90, inStock: true }))).toEqual([]);
  });
  it("re-applies the price cap and the minimum to the live price", () => {
    expect(applyLive([pick({})], 50, new Map([["1", live({ price: 55 })]]), supply)).toEqual([]);
    expect(applyLive([pick({})], 120, new Map([["1", live({ price: 12 })]]), supply)).toEqual([]);
  });
});

describe("#2 / N3 verifyLive — one Shopify call + Turso rows by SKU, never the feed", () => {
  beforeEach(() => {
    vi.mocked(shopifyFetch).mockReset();
    vi.mocked(fetchAosomCatalog).mockReset();
  });
  it("reads live variants, Aosom qty (catalogue cost) and Costway cost/stock — no feed download", async () => {
    vi.mocked(shopifyFetch).mockResolvedValue(new Response(JSON.stringify({ data: { nodes: [
      { id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "62.00", compareAtPrice: null, image: null, product: { title: "Table", status: "ACTIVE", onlineStoreUrl: "https://x", featuredImage: { url: "https://cdn/f.jpg" } } },
      { id: "gid://shopify/ProductVariant/2", title: "Gris", price: "70.00", compareAtPrice: null, image: { url: "https://cdn/g.jpg" }, product: { title: "Miroir", status: "ACTIVE", onlineStoreUrl: "https://x", featuredImage: null } },
    ] } }), { status: 200 }));
    const execute = vi.fn(async (q: { sql: string }) =>
      /FROM products/.test(q.sql) ? { rows: [{ sku: "A-1", qty: 4 }] } : { rows: [{ internal_sku: "C-2", price: 50, in_stock: 1, qty: 3, ca_qty: 3 }] },
    );
    vi.mocked(ensureSchema).mockResolvedValue({ execute } as never);
    const out = await verifyLive([pick({}), pick({ variantId: "2", productId: "p2", sku: "C-2", source: "costway" })], 120);
    expect(out.map((p) => [p.title, p.price, p.imageUrl, p.cost])).toEqual([
      ["Table", 62, "https://cdn/f.jpg", 30],
      ["Miroir — Gris", 70, "https://cdn/g.jpg", 42],
    ]);
    expect(JSON.parse(String(vi.mocked(shopifyFetch).mock.calls[0][1]?.body)).variables.ids).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"]);
    expect(fetchAosomCatalog).not.toHaveBeenCalled();
    const args = execute.mock.calls.map((c) => (c[0] as unknown as { args: string[] }).args);
    expect(args).toContainEqual(["A-1"]);
    expect(args).toContainEqual(["C-2"]);
  });
  it("N3 fails closed when a call hangs (timeout rejects)", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "hang")).rejects.toThrow(/timeout after 20 ms: hang/);
    await expect(withTimeout(Promise.resolve(7), 20, "ok")).resolves.toBe(7);
  });
  it("N3 Aosom supply = catalogue cost + Turso qty; unknown SKU → null", () => {
    const sup = supplyFrom(new Map([["A-1", 0], ["A-2", 5]]), new Map());
    expect(sup({ sku: "A-1", source: "aosom", cost: 30 })).toEqual({ cost: 30, inStock: false });
    expect(sup({ sku: "A-2", source: "aosom", cost: 30 })).toEqual({ cost: 30, inStock: true });
    expect(sup({ sku: "A-9", source: "aosom", cost: 30 })).toBeNull();
  });
});

describe("N6 sibling fallback", () => {
  it("uses the next sibling variant when the chosen one fails live, keeping the product's rank", () => {
    const sib = { ...pick({ variantId: "9", sku: "A-9", title: "Table — Gris" }) };
    delete (sib as Partial<MerciPick>).why;
    const ranked = [pick({ siblings: [sib] }), pick({ variantId: "5", productId: "p5", sku: "A-5", type: "C > D" })];
    const liveMap = new Map([["1", live({ active: true, published: false })], ["9", live({ variantId: "9", title: "Table — Gris", price: 61 })], ["5", live({ variantId: "5", title: "Lampe" })]]);
    const out = applyLive(ranked, 120, liveMap, () => ({ cost: 30, inStock: true }));
    expect(out.map((p) => [p.variantId, p.title, p.why])).toEqual([["9", "Table — Gris", "w"], ["5", "Lampe", "w"]]);
    expect(out[0].siblings).toBeUndefined();
  });
  it("pickOffers keeps up to 2 siblings per product", async () => {
    const { pickOffers } = await import("@/lib/post-purchase/offer-rules");
    const L = "Home Furnishings > Living Room Furniture";
    const c = (v: string, price: number) => ({ variantId: v, productId: "77", sku: "S" + v, source: "aosom" as const, handle: "h", title: "T" + v, type: `${L} > Side Tables`, colour: null, price, compareAt: null, cost: 20, imageUrl: "x", pct: 10 });
    const res = pickOffers([{ productId: "1", productType: `${L} > Sofas & Reclining Chairs`, title: "Sofa", price: 240 }], [c("1", 72), c("2", 60), c("3", 80), c("4", 90)], { now: new Date("2026-11-21T15:00:00Z") });
    expect(res.ranked).toHaveLength(1);
    expect(res.ranked[0].siblings?.length).toBe(2);
  });
});

describe("#2 liveCheckSet — keeps room for an alternative of another type", () => {
  it("takes 4 of the top type and 4 of other types, in rank order", () => {
    const ranked = [..."aaaaaaaaab".split(""), "c", "d"].map((type, i) => ({ type, i }));
    expect(liveCheckSet(ranked).map((x) => x.type).join("")).toBe("aaaabcd");
    expect(liveCheckSet([{ type: "a" }, { type: "b" }]).length).toBe(2);
  });
});

describe("#3 variantDisplayTitle", () => {
  it("adds the colour, drops dimensions and « Default Title »", () => {
    expect(variantDisplayTitle("Miroir mural", "Noir / 28L x 20W po")).toBe("Miroir mural — Noir");
    expect(variantDisplayTitle("Table", "44 × 44 × 51 cm")).toBe("Table — 44 × 44 × 51 cm");
    expect(variantDisplayTitle("Table", "Default Title")).toBe("Table");
  });
});

describe("#4 / #5 order guards", () => {
  const order = { customerId: "gid://shopify/Customer/77", confirmationNumber: "L8UWCL9KC" };
  it("confirmation number must match (case-insensitive)", () => {
    expect(callerOwnsOrder(order, { confirmationNumber: "l8uwcl9kc" })).toBe(true);
    expect(callerOwnsOrder(order, { confirmationNumber: "OTHER" })).toBe(false);
    expect(callerOwnsOrder(order, {})).toBe(false);
  });
  it("a token customer must be the order's customer", () => {
    expect(callerOwnsOrder(order, { confirmationNumber: "L8UWCL9KC", sub: "gid://shopify/Customer/77" })).toBe(true);
    expect(callerOwnsOrder(order, { confirmationNumber: "L8UWCL9KC", sub: "gid://shopify/Customer/8" })).toBe(false);
    expect(callerOwnsOrder({ customerId: null, confirmationNumber: "X" }, { confirmationNumber: "X", sub: "gid://shopify/Customer/8" })).toBe(false);
  });
  it("an order without a confirmation number needs the logged-in buyer", () => {
    expect(callerOwnsOrder({ customerId: "gid://shopify/Customer/77", confirmationNumber: null }, {})).toBe(false);
    expect(callerOwnsOrder({ customerId: "gid://shopify/Customer/77", confirmationNumber: null }, { sub: "gid://shopify/Customer/77" })).toBe(true);
  });
  it("N4 says which ownership check failed (for the [merci] 403 log)", () => {
    expect(ownershipProblem(order, {})).toBe("confirmation-missing");
    expect(ownershipProblem(order, { confirmationNumber: "X" })).toBe("confirmation-mismatch");
    expect(ownershipProblem(order, { confirmationNumber: "L8UWCL9KC", sub: "gid://shopify/Customer/8" })).toBe("token-customer-mismatch");
    expect(ownershipProblem({ customerId: null, confirmationNumber: "X" }, { sub: "gid://shopify/Customer/8" })).toBe("token-customer-on-guest-order");
    expect(ownershipProblem({ customerId: null, confirmationNumber: null }, {})).toBe("no-confirmation-and-no-token-customer");
    expect(ownershipProblem(order, { confirmationNumber: "L8UWCL9KC" })).toBeNull();
  });
  it("detects an order paid with a MERCI code", () => {
    expect(usedMerciCode({ discountCodes: ["BIENVENUE20"] })).toBe(false);
    expect(usedMerciCode({ discountCodes: [" merci-ABC2345"] })).toBe(true);
  });
});
