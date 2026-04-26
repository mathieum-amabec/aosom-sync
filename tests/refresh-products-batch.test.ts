import { describe, it, expect, vi, beforeEach } from "vitest";

describe("refreshProducts — batch_size=1000", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TURSO_DATABASE_URL = "libsql://fake-for-test";
    process.env.TURSO_AUTH_TOKEN = "fake-token-for-test";
  });

  it("splits 1500 products into 2 batches: first 1000, second 500", async () => {
    const batchMock = vi.fn().mockResolvedValue(undefined);
    const executeMock = vi.fn().mockResolvedValue({ rows: [] });

    vi.doMock("@libsql/client", () => ({
      createClient: () => ({ batch: batchMock, execute: executeMock }),
    }));

    const { refreshProducts } = await import("@/lib/database");

    // Warm up schema init (singleton — runs once), then clear the mock so only
    // the refresh batches are counted in the assertions below.
    await refreshProducts([]);
    batchMock.mockClear();

    const products = Array.from({ length: 1500 }, (_, i) => ({
      sku: `SKU-${i}`,
      name: `Product ${i}`,
      price: 9.99,
      qty: 5,
      color: "",
      size: "",
      product_type: "",
      image1: "",
      image2: "",
      image3: "",
      image4: "",
      image5: "",
      image6: "",
      image7: "",
      video: "",
      description: "",
      short_description: "",
      material: "",
      gtin: "",
      weight: 0,
      out_of_stock_expected: "",
      estimated_arrival: "",
      last_seen_at: 0,
    }));

    await refreshProducts(products);

    const writeBatches = batchMock.mock.calls.filter((c) => c[1] === "write");
    expect(writeBatches).toHaveLength(2);
    expect(writeBatches[0][0]).toHaveLength(1000);
    expect(writeBatches[1][0]).toHaveLength(500);
  });
});
