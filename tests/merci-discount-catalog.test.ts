import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn(), parseLinkHeader: vi.fn() }));

import { shopifyFetch } from "@/lib/shopify-client";
import { merciDiscountInput, generateMerciCode, deletableMerciNodes, cleanupExpiredMerciCodes, createMerciDiscount } from "@/lib/post-purchase/discount";
import { buildCandidates, type ShopProduct, type SupplierInfo } from "@/lib/post-purchase/catalog";
import { toOrderGid } from "@/lib/post-purchase/order";

const now = new Date("2026-11-21T15:00:00Z");
const ends = new Date("2026-11-21T15:30:00Z");

function res(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("merciDiscountInput", () => {
  it("is a single-use percentage code on ONE variant, ending with the offer, shipping-combinable only", () => {
    const input = merciDiscountInput("MERCI-ABCDEFG", { variantId: "111", pct: 10, orderName: "#1150" }, now, ends);
    expect(input).toEqual({
      title: "MERCI-ABCDEFG — Offre de remerciement — #1150",
      code: "MERCI-ABCDEFG",
      startsAt: now.toISOString(),
      endsAt: ends.toISOString(),
      customerSelection: { all: true },
      customerGets: { value: { percentage: 0.1 }, items: { products: { productVariantsToAdd: ["gid://shopify/ProductVariant/111"] } } },
      usageLimit: 1,
      appliesOncePerCustomer: true,
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
    });
  });
  it("refuses anything above MAX_DISCOUNT (10 %)", () => {
    expect(() => merciDiscountInput("MERCI-X", { variantId: "1", pct: 15, orderName: null }, now, ends)).toThrow();
    expect(() => merciDiscountInput("MERCI-X", { variantId: "1", pct: 0, orderName: null }, now, ends)).toThrow();
  });
  it("codes look like MERCI-XXXXXXX without ambiguous characters", () => {
    for (let i = 0; i < 50; i++) expect(generateMerciCode()).toMatch(/^MERCI-[A-HJ-NP-Z2-9]{7}$/);
  });
});

describe("createMerciDiscount", () => {
  beforeEach(() => vi.mocked(shopifyFetch).mockReset());
  it("retries once on a taken code, then returns the node id", async () => {
    vi.mocked(shopifyFetch)
      .mockResolvedValueOnce(res({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "Code must be unique", code: "TAKEN" }] } } }))
      .mockResolvedValueOnce(res({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/9" }, userErrors: [] } } }));
    const out = await createMerciDiscount({ variantId: "1", pct: 5, orderName: null }, now, ends);
    expect(out.discountId).toBe("gid://shopify/DiscountCodeNode/9");
    expect(out.code).toMatch(/^MERCI-/);
  });
});

describe("cleanup of expired MERCI codes", () => {
  beforeEach(() => vi.mocked(shopifyFetch).mockReset());
  const nodes = [
    { id: "a", title: "MERCI-AAA — Offre de remerciement", endsAt: "2026-11-18T10:00:00Z" },
    { id: "b", title: "MERCI-BBB — Offre de remerciement", endsAt: "2026-11-20T10:00:00Z" }, // < 2 days ago → kept
    { id: "c", title: "ROUE-CCC", endsAt: "2026-11-01T10:00:00Z" }, // not ours
    { id: "d", title: "MERCI-DDD", endsAt: null },
  ];
  it("only ours, only ended more than 2 days ago", () => {
    expect(deletableMerciNodes(nodes, new Date(now.getTime() - 2 * 86_400_000)).map((n) => n.id)).toEqual(["a"]);
  });
  it("dry run lists without deleting", async () => {
    vi.mocked(shopifyFetch).mockResolvedValueOnce(res({ data: { codeDiscountNodes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: nodes.map((n) => ({ id: n.id, codeDiscount: { title: n.title, endsAt: n.endsAt } })) } } }));
    expect(await cleanupExpiredMerciCodes({ dryRun: true, now })).toEqual({ found: 1, deleted: 0 });
    expect(shopifyFetch).toHaveBeenCalledTimes(1);
  });
  it("deletes the doomed ones", async () => {
    vi.mocked(shopifyFetch)
      .mockResolvedValueOnce(res({ data: { codeDiscountNodes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: nodes.map((n) => ({ id: n.id, codeDiscount: { title: n.title, endsAt: n.endsAt } })) } } }))
      .mockResolvedValueOnce(res({ data: { discountCodeDelete: { deletedCodeDiscountId: "a", userErrors: [] } } }));
    expect(await cleanupExpiredMerciCodes({ now })).toEqual({ found: 1, deleted: 1 });
    expect(JSON.parse(String(vi.mocked(shopifyFetch).mock.calls[1][1]?.body)).variables).toEqual({ id: "a" });
  });
});

describe("buildCandidates", () => {
  const product = (over: Partial<ShopProduct>): ShopProduct => ({
    id: 1, handle: "h", title: "Table", product_type: "Home Furnishings > Living Room Furniture > Side Tables", tags: "", status: "active",
    published_at: "2026-01-01T00:00:00Z", image: { src: "https://cdn/x.jpg" },
    variants: [{ id: 11, sku: "A-1", price: "65.88", compare_at_price: "99.99" }],
    ...over,
  });
  const info: Record<string, SupplierInfo> = {
    "A-1": { cost: 38, inStock: true, colour: "Black", photoOk: true },
    "A-thin": { cost: 60, inStock: true, colour: null, photoOk: true },
    "A-out": { cost: 20, inStock: false, colour: null, photoOk: true },
    "A-photo": { cost: 20, inStock: true, colour: null, photoOk: false },
    "C-1": { cost: 30, inStock: true, colour: null, photoOk: true },
  };
  const lookup = vi.fn((sku: string) => info[sku] ?? null);

  it("keeps active, published, in-stock, photo-checked variants that can afford a tier", () => {
    const out = buildCandidates([product({})], lookup);
    expect(out).toEqual([{ variantId: "11", productId: "1", handle: "h", title: "Table", type: "Home Furnishings > Living Room Furniture > Side Tables", colour: "Black", price: 65.88, compareAt: 99.99, cost: 38, imageUrl: "https://cdn/x.jpg", pct: 10 }]);
  });
  it("drops unpublished, draft, no-image, internal warranty, out of stock, unchecked photo, no tier, unknown cost", () => {
    const v = (sku: string) => [{ id: 2, sku, price: "65.88", compare_at_price: null }];
    const out = buildCandidates(
      [
        product({ published_at: null }),
        product({ status: "draft" }),
        product({ image: null }),
        product({ product_type: "Garantie" }),
        product({ variants: v("A-out") }),
        product({ variants: v("A-photo") }),
        product({ variants: v("A-thin") }),
        product({ variants: v("UNKNOWN") }),
      ],
      lookup,
    );
    expect(out).toEqual([]);
  });
  it("routes src-c products to the Costway lookup", () => {
    lookup.mockClear();
    buildCandidates([product({ tags: "src-c, salon", variants: [{ id: 3, sku: "C-1", price: "79.99", compare_at_price: null }] })], lookup);
    expect(lookup).toHaveBeenCalledWith("C-1", "costway");
  });
});

describe("toOrderGid", () => {
  it("accepts OrderIdentity / Order GIDs and bare numbers", () => {
    expect(toOrderGid("gid://shopify/OrderIdentity/6001")).toBe("gid://shopify/Order/6001");
    expect(toOrderGid("gid://shopify/Order/6001")).toBe("gid://shopify/Order/6001");
    expect(toOrderGid(6001)).toBe("gid://shopify/Order/6001");
    expect(toOrderGid("gid://shopify/Customer/1")).toBeNull();
    expect(toOrderGid("6001; DROP")).toBeNull();
  });
});
