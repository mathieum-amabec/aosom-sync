import { describe, it, expect, vi, beforeEach } from "vitest";

const shopifyFetch = vi.hoisted(() => vi.fn());
const getInsights = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch }));
vi.mock("@/lib/meta-ads-client", () => ({ getInsights }));

import { collectShopSummary } from "@/lib/shop-analytics";

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const ql = (rows: Array<Record<string, unknown>>) =>
  json({ data: { shopifyqlQuery: { parseErrors: [], tableData: { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows } } } });

const order = (createdAt: string, total: string, over: Record<string, unknown> = {}) => ({
  createdAt,
  totalPriceSet: { shopMoney: { amount: total } },
  cancelledAt: null,
  customerJourneySummary: { lastVisit: { source: "facebook", utmParameters: { campaign: "52598252103605" } } },
  ...over,
});

function route(orders: unknown[]) {
  shopifyFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.query.includes("shopifyqlQuery")) {
      const q: string = body.variables.q;
      if (q.startsWith("FROM sales")) return ql([{ orders: 2, total_sales: 300 }]);
      if (q.includes("GROUP BY referrer_source")) return ql([{ referrer_source: "social", sessions: 90, sessions_that_completed_checkout: 1 }]);
      return ql([{ sessions: 100, sessions_with_cart_additions: 5, sessions_that_reached_checkout: 3, sessions_that_completed_checkout: 2 }]);
    }
    return json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: orders } } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getInsights.mockResolvedValue([{ spend: "200" }]);
});

describe("collectShopSummary", () => {
  it("only counts orders inside the Montreal day, even when the search returns later ones, and skips cancelled orders", async () => {
    route([
      order("2026-10-21T14:22:00Z", "159.80"), // inside 2026-10-21 (04:00Z → 04:00Z next day)
      order("2026-10-22T15:58:00Z", "82.77"), // the next day: must not be counted
      order("2026-10-20T20:00:00Z", "50.00"), // the day before
      order("2026-10-21T18:00:00Z", "99.00", { cancelledAt: "2026-10-21T19:00:00Z" }),
    ]);
    const s = await collectShopSummary("2026-10-21", "act_1");
    expect(s.dayOrderSources).toEqual([{ label: "Meta (pub)", orders: 1, total: 159.8 }]);
  });

  it("builds the funnel/sales from ShopifyQL and the Meta cost per Shopify-attributed order", async () => {
    route([order("2026-10-18T14:00:00Z", "100"), order("2026-10-19T14:00:00Z", "100"), order("2026-10-21T14:00:00Z", "100")]);
    const s = await collectShopSummary("2026-10-21", "act_1");
    expect(s.dayFunnel).toMatchObject({ sessions: 100, carts: 5, checkouts: 3, bought: 2, conversion: 0.02 });
    expect(s.daySales).toEqual({ orders: 2, total: 300, aov: 150 });
    expect(s.sources).toEqual([{ name: "réseaux sociaux", sessions: 90, bought: 1, conversion: 1 / 90 }]);
    expect(s.weekStart).toBe("2026-10-15");
    expect(s.meta).toEqual({ spend: 200, orders: 3, costPerOrder: 200 / 3 });
    expect(getInsights).toHaveBeenCalledWith("act_1", { since: "2026-10-15", until: "2026-10-21" });
  });

  it("keeps the Shopify numbers when Meta is unavailable", async () => {
    route([]);
    getInsights.mockRejectedValue(new Error("token expired"));
    const s = await collectShopSummary("2026-10-21", "act_1");
    expect(s.meta).toEqual({ error: "token expired" });
    expect(s.daySales.orders).toBe(2);
    const noAccount = await collectShopSummary("2026-10-21", null);
    expect(noAccount.meta).toEqual({ error: "compte Meta indisponible" });
  });

  it("fails loudly (so the report marks the section unavailable) when ShopifyQL is refused", async () => {
    shopifyFetch.mockResolvedValue(json({ errors: [{ message: "ACCESS_DENIED" }] }));
    await expect(collectShopSummary("2026-10-21", null)).rejects.toThrow(/ACCESS_DENIED/);
  });
});
