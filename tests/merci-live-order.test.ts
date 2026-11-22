import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn(), parseLinkHeader: vi.fn() }));
vi.mock("@/lib/csv-fetcher", () => ({ fetchAosomCatalog: vi.fn() }));
vi.mock("@/lib/database", () => ({ ensureSchema: vi.fn() }));

import { shopifyFetch } from "@/lib/shopify-client";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { ensureSchema } from "@/lib/database";
import { applyLive, verifyLive, liveCheckSet, __resetFeedCacheForTests, type LiveVariant } from "@/lib/post-purchase/live-check";
import { variantDisplayTitle } from "@/lib/post-purchase/catalog";
import { callerOwnsOrder, usedMerciCode } from "@/lib/post-purchase/order";
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

describe("#2 verifyLive — one Shopify call, today's feed for Aosom, the table for Costway", () => {
  beforeEach(() => {
    vi.mocked(shopifyFetch).mockReset();
    __resetFeedCacheForTests();
  });
  it("reads live variants and supplier cost/stock", async () => {
    vi.mocked(shopifyFetch).mockResolvedValue(new Response(JSON.stringify({ data: { nodes: [
      { id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "62.00", compareAtPrice: null, image: null, product: { title: "Table", status: "ACTIVE", onlineStoreUrl: "https://x", featuredImage: { url: "https://cdn/f.jpg" } } },
      { id: "gid://shopify/ProductVariant/2", title: "Gris", price: "70.00", compareAtPrice: null, image: { url: "https://cdn/g.jpg" }, product: { title: "Miroir", status: "ACTIVE", onlineStoreUrl: "https://x", featuredImage: null } },
    ] } }), { status: 200 }));
    vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "A-1", cost: 30, qty: 4 }] as never);
    const execute = vi.fn().mockResolvedValue({ rows: [{ internal_sku: "C-2", price: 50, in_stock: 1, qty: 3, ca_qty: 3 }] });
    vi.mocked(ensureSchema).mockResolvedValue({ execute } as never);
    const out = await verifyLive([pick({}), pick({ variantId: "2", productId: "p2", sku: "C-2", source: "costway" })], 120);
    expect(out.map((p) => [p.title, p.price, p.imageUrl, p.cost])).toEqual([
      ["Table", 62, "https://cdn/f.jpg", 30],
      ["Miroir — Gris", 70, "https://cdn/g.jpg", 42],
    ]);
    expect(JSON.parse(String(vi.mocked(shopifyFetch).mock.calls[0][1]?.body)).variables.ids).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"]);
    expect(execute.mock.calls[0][0].args).toEqual(["C-2"]);
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
  it("detects an order paid with a MERCI code", () => {
    expect(usedMerciCode({ discountCodes: ["BIENVENUE20"] })).toBe(false);
    expect(usedMerciCode({ discountCodes: [" merci-ABC2345"] })).toBe(true);
  });
});
