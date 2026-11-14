import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so libsql (no win-arm64 build) never loads.
const db = vi.hoisted(() => ({
  lookupVariant: vi.fn(),
  getCostwayCatalog: vi.fn(),
  getCostwaySummary: vi.fn(),
  getImportSummary: vi.fn(),
}));
vi.mock("@/lib/costway/db", () => db);
vi.mock("@/lib/costway/sync", () => ({ getCostwayLastSync: vi.fn().mockResolvedValue(null) }));

import { GET as lookupGET } from "@/app/api/costway/lookup/route";
import { GET as catalogGET } from "@/app/api/costway/route";

beforeEach(() => {
  vi.clearAllMocks();
  db.lookupVariant.mockResolvedValue([]);
  db.getCostwayCatalog.mockResolvedValue({ products: [], total: 0 });
  db.getCostwaySummary.mockResolvedValue({ products: 0, inStockProducts: 0, variants: 0, inStockVariants: 0, categories: [], promoTags: [] });
  db.getImportSummary.mockResolvedValue({ importedProducts: 0, importedVariants: 0, byStatus: [], byBatch: [], estimatedMarginPerSale: 0 });
});

describe("GET /api/costway/lookup", () => {
  it("400s on a missing or blank q, without touching the DB", async () => {
    for (const url of ["https://app.test/api/costway/lookup", "https://app.test/api/costway/lookup?q=", "https://app.test/api/costway/lookup?q=%20%20"]) {
      const res = await lookupGET(new Request(url));
      expect(res.status).toBe(400);
      expect((await res.json()).success).toBe(false);
    }
    expect(db.lookupVariant).not.toHaveBeenCalled();
  });

  it("400s on an absurdly long q", async () => {
    const res = await lookupGET(new Request(`https://app.test/api/costway/lookup?q=${"M".repeat(200)}`));
    expect(res.status).toBe(400);
  });

  it("returns {success, data} with the hits for a SKU", async () => {
    db.lookupVariant.mockResolvedValue([{ internal_sku: "M7ZGG3GC", supplier_sku: "111_BK" }]);
    const res = await lookupGET(new Request("https://app.test/api/costway/lookup?q=%20m7zgg3gc%20"));
    expect(res.status).toBe(200);
    expect(db.lookupVariant).toHaveBeenCalledWith("m7zgg3gc");
    expect(await res.json()).toEqual({ success: true, data: [{ internal_sku: "M7ZGG3GC", supplier_sku: "111_BK" }] });
  });

  it("answers an empty data array for an unknown SKU", async () => {
    const res = await lookupGET(new Request("https://app.test/api/costway/lookup?q=M0000000"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: [] });
  });

  it("never leaks a raw error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.lookupVariant.mockRejectedValue(new Error("SQLITE_BUSY: secret detail"));
    const res = await lookupGET(new Request("https://app.test/api/costway/lookup?q=M7ZGG3GC"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Internal server error" });
  });
});

describe("GET /api/costway — import filters", () => {
  it("forwards imported / batch and returns the import summary", async () => {
    const res = await catalogGET(new Request("https://app.test/api/costway?imported=only&batch=pilot-1"));
    expect(res.status).toBe(200);
    expect(db.getCostwayCatalog).toHaveBeenCalledWith(expect.objectContaining({ imported: "only", batch: "pilot-1" }));
    const json = await res.json();
    expect(json.data.importSummary).toEqual(expect.objectContaining({ importedProducts: 0 }));
  });

  it("defaults imported to 'all' and ignores an unknown value", async () => {
    await catalogGET(new Request("https://app.test/api/costway"));
    expect(db.getCostwayCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ imported: "all", batch: undefined }));
    await catalogGET(new Request("https://app.test/api/costway?imported=bogus"));
    expect(db.getCostwayCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ imported: "all" }));
  });
});
