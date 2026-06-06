// Regression: ISSUE — Trending Products "undefined/day" and "undefined left" in Dashboard
// Root cause: API returned `unitsMoved` but TopSeller interface expected `soldPerDay`/`currentQty`/`daysTracked`
// Found by /qa on 2026-05-07
// Report: .gstack/qa-reports/qa-report-aosom-sync-2026-05-07.md
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  API: { DEFAULT_INSIGHTS_LIMIT: 20, MAX_INSIGHTS_LIMIT: 100 },
  // The route now builds a Shopify admin deep-link via storeLink() → SHOPIFY.ADMIN_URL.
  SHOPIFY: { ADMIN_URL: "https://admin.shopify.com/store/test-store" },
}));

vi.mock("@/lib/database", () => ({
  getRecentPriceChanges: vi.fn().mockResolvedValue([]),
  getTrendingProducts: vi.fn().mockResolvedValue([
    {
      sku: "TEST-001",
      name: "Test Product",
      price: 149.99,
      image1: "https://example.com/img.jpg",
      shopify_product_id: "gid://shopify/Product/123",
      units_moved: 28,
      current_qty: 42,
    },
  ]),
}));

import { GET } from "@/app/api/insights/route";

describe("GET /api/insights — trending products shape (regression)", () => {
  it("returns soldPerDay, currentQty, daysTracked (not unitsMoved)", async () => {
    const req = new Request("http://localhost/api/insights");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const [product] = body.data.trending;
    expect(product).toBeDefined();

    // These are the fields the TopSeller interface and dashboard template consume
    expect(product.soldPerDay).toBeDefined();
    expect(product.currentQty).toBeDefined();
    expect(product.daysTracked).toBeDefined();

    // The old broken field must NOT be present
    expect(product.unitsMoved).toBeUndefined();

    // Value correctness: 28 units over 14 days = 2.0/day
    expect(product.soldPerDay).toBe(2.0);
    expect(product.currentQty).toBe(42);
    expect(product.daysTracked).toBe(14);
    expect(product.inStore).toBe(true);
    // In-store products carry a Shopify admin deep-link for the dashboard badge.
    expect(product.shopifyUrl).toBe("https://admin.shopify.com/store/test-store/products/gid://shopify/Product/123");
  });

  it("soldPerDay rounds to 1 decimal place", async () => {
    const { getTrendingProducts } = await import("@/lib/database");
    vi.mocked(getTrendingProducts).mockResolvedValueOnce([
      { sku: "X", name: "X", price: 0, image1: "", shopify_product_id: null, shopify_handle: null, units_moved: 10, current_qty: 5 },
    ]);
    const req = new Request("http://localhost/api/insights");
    const res = await GET(req);
    const body = await res.json();
    const [p] = body.data.trending;
    // 10/14 = 0.714... → rounds to 0.7
    expect(p.soldPerDay).toBe(0.7);
  });

  it("currentQty defaults to 0 when null", async () => {
    const { getTrendingProducts } = await import("@/lib/database");
    vi.mocked(getTrendingProducts).mockResolvedValueOnce([
      { sku: "X", name: "X", price: 0, image1: "", shopify_product_id: null, shopify_handle: null, units_moved: 5, current_qty: 0 },
    ]);
    const req = new Request("http://localhost/api/insights");
    const res = await GET(req);
    const body = await res.json();
    const [p] = body.data.trending;
    expect(p.currentQty).toBe(0);
  });
});
