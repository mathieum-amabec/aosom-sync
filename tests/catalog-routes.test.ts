import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so libsql (no win-arm64 build) never loads.
const db = vi.hoisted(() => ({ getProducts: vi.fn(), getCatalogStats: vi.fn() }));
vi.mock("@/lib/database", () => db);

import { GET as catalogGET } from "@/app/api/catalog/route";
import { GET as statsGET } from "@/app/api/catalog/stats/route";

beforeEach(() => {
  vi.clearAllMocks();
  db.getProducts.mockResolvedValue({ products: [], total: 0, productTypes: [] });
  db.getCatalogStats.mockResolvedValue({
    total: 100,
    imported: 30,
    withDiscount: 12,
    lastSync: { name: "sync", status: "success", ranAt: 1718000000 },
  });
});

describe("GET /api/catalog — new filter params", () => {
  it("forwards notImported / withDiscount / lowStock as booleans", async () => {
    const url = "https://app.test/api/catalog?notImported=true&withDiscount=true&lowStock=true";
    const res = await catalogGET(new Request(url));
    expect(res.status).toBe(200);
    expect(db.getProducts).toHaveBeenCalledWith(
      expect.objectContaining({ notImported: true, withDiscount: true, lowStock: true }),
    );
  });

  it("defaults the new filters to false when absent", async () => {
    const res = await catalogGET(new Request("https://app.test/api/catalog"));
    expect(res.status).toBe(200);
    expect(db.getProducts).toHaveBeenCalledWith(
      expect.objectContaining({ notImported: false, withDiscount: false, lowStock: false }),
    );
  });

  it("still passes the existing filters through", async () => {
    const url = "https://app.test/api/catalog?productType=Chairs&minPrice=10&inStock=true";
    await catalogGET(new Request(url));
    expect(db.getProducts).toHaveBeenCalledWith(
      expect.objectContaining({ productType: "Chairs", minPrice: 10, inStock: true }),
    );
  });
});

describe("GET /api/catalog/stats", () => {
  it("returns the catalog stats payload", async () => {
    const res = await statsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      total: 100,
      imported: 30,
      withDiscount: 12,
      lastSync: { name: "sync", status: "success", ranAt: 1718000000 },
    });
  });

  it("500s when the DB call throws", async () => {
    db.getCatalogStats.mockRejectedValue(new Error("boom"));
    const res = await statsGET();
    expect(res.status).toBe(500);
  });
});
