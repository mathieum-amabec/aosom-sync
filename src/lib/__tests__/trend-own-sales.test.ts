import { describe, it, expect, vi, beforeEach } from "vitest";

const shopifyFetch = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: (...a: unknown[]) => shopifyFetch(...a) }));

import {
  ownSalesWeight,
  fetchOwnSales,
  scoreProducts,
  DEFAULT_TREND_WEIGHTS,
  OWN_MAX_WEIGHT,
  OWN_MIN_ORDERS,
  OWN_FULL_ORDERS,
} from "@/lib/trend-score";

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    sku: "SKU-1",
    product_type: "Home Furnishings > Living Room Furniture",
    shopify_product_id: "111",
    shopify_handle: "a-product",
    qty: 10,
    price: 100,
    velocity: 10,
    compare_at_price: null,
    ...over,
  } as Parameters<typeof scoreProducts>[0][number];
}

describe("ownSalesWeight — ramps with order volume", () => {
  it("is 0 below the minimum (a few orders are noise)", () => {
    expect(ownSalesWeight(0)).toBe(0);
    expect(ownSalesWeight(OWN_MIN_ORDERS - 1)).toBe(0);
    expect(ownSalesWeight(NaN)).toBe(0);
  });
  it("rises linearly and caps at the max", () => {
    expect(ownSalesWeight(OWN_MIN_ORDERS)).toBe(0);
    const mid = (OWN_MIN_ORDERS + OWN_FULL_ORDERS) / 2;
    expect(ownSalesWeight(mid)).toBeCloseTo(OWN_MAX_WEIGHT / 2, 6);
    expect(ownSalesWeight(OWN_FULL_ORDERS)).toBe(OWN_MAX_WEIGHT);
    expect(ownSalesWeight(500)).toBe(OWN_MAX_WEIGHT);
  });
});

describe("scoreProducts — own-sales blend", () => {
  const rows = [
    row({ sku: "FAST", shopify_product_id: "1", velocity: 100 }),
    row({ sku: "OURS", shopify_product_id: "2", velocity: 2 }),
  ];
  it("weight 0 keeps the previous ranking exactly", () => {
    const a = scoreProducts(rows, DEFAULT_TREND_WEIGHTS);
    const b = scoreProducts(rows, { ...DEFAULT_TREND_WEIGHTS, own: 0 }, new Map([["2", 9]]));
    expect(b.map((p) => [p.sku, p.score])).toEqual(a.map((p) => [p.sku, p.score]));
  });
  it("at full weight, what our customers buy climbs above supplier-wide velocity", () => {
    const out = scoreProducts(rows, { ...DEFAULT_TREND_WEIGHTS, own: 0.35 }, new Map([["2", 6]]));
    expect(out[0].sku).toBe("OURS");
    expect(out[0].ownUnits).toBe(6);
    expect(out[0].ownNorm).toBe(1);
  });
  it("scores stay within 0..1", () => {
    for (const p of scoreProducts(rows, { ...DEFAULT_TREND_WEIGHTS, own: 0.35 }, new Map([["1", 3], ["2", 1]]))) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("fetchOwnSales", () => {
  beforeEach(() => shopifyFetch.mockReset());
  const ok = (body: unknown, link = "") =>
    ({ ok: true, json: async () => body, headers: new Headers(link ? { link } : {}) }) as Response;

  it("sums units per product across pages", async () => {
    shopifyFetch
      .mockResolvedValueOnce(ok(
        { orders: [{ line_items: [{ product_id: 1, quantity: 2 }, { product_id: null, quantity: 1 }] }] },
        '<https://s.myshopify.com/admin/api/2025-01/orders.json?page_info=abc&limit=250>; rel="next"',
      ))
      .mockResolvedValueOnce(ok({ orders: [{ line_items: [{ product_id: 1, quantity: 1 }, { product_id: 7 }] }] }));
    const s = await fetchOwnSales(30);
    expect(s.available).toBe(true);
    expect(s.orders).toBe(2);
    expect(s.units.get("1")).toBe(3);
    expect(s.units.get("7")).toBe(1);
    expect(shopifyFetch.mock.calls[1][0]).toBe("/orders.json?page_info=abc&limit=250");
  });
  it("missing read_orders scope (403) = unavailable, weight 0, never throws", async () => {
    shopifyFetch.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    const s = await fetchOwnSales();
    expect(s).toEqual({ orders: 0, units: new Map(), available: false });
    expect(ownSalesWeight(s.orders)).toBe(0);
  });
  it("network error = unavailable", async () => {
    shopifyFetch.mockRejectedValueOnce(new Error("boom"));
    expect((await fetchOwnSales()).available).toBe(false);
  });
});
