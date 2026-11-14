import { describe, it, expect } from "vitest";
import { parseCompetitorProducts, fetchCompetitorPrices, MIN_COMPETITOR_SKUS } from "@/lib/competitor-prices";

describe("parseCompetitorProducts", () => {
  it("maps upper-cased SKUs to prices and keeps the first price seen", () => {
    const m = parseCompetitorProducts([
      { variants: [{ sku: "84c-418v00mx", price: "902.99" }, { sku: "A-1", price: "10.00" }] },
      { variants: [{ sku: "84C-418V00MX", price: "999.99" }] },
    ]);
    expect(m.get("84C-418V00MX")).toBe(902.99);
    expect(m.get("A-1")).toBe(10);
  });
  it("skips blank SKUs and non-positive or non-numeric prices", () => {
    const m = parseCompetitorProducts([{ variants: [{ sku: "", price: "5" }, { sku: "X", price: "0" }, { sku: "Y", price: "abc" }, { sku: "Z", price: "7.5" }] }]);
    expect([...m.keys()]).toEqual(["Z"]);
  });
});

describe("fetchCompetitorPrices", () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ variants: [{ sku: `S${from + i}`, price: "10.99" }] }));

  it("reads pages until an empty one and returns the map", async () => {
    const pages = [page(0, 2000), page(2000, 2000), []];
    let i = 0;
    const m = await fetchCompetitorPrices({ fetchPage: async () => pages[i++], delayMs: 0 });
    expect(m).not.toBeNull();
    expect(m!.size).toBe(4000);
  });
  it("returns null, never a half catalogue, when a page fails mid-way", async () => {
    const pages = [page(0, 4000), null];
    let i = 0;
    expect(await fetchCompetitorPrices({ fetchPage: async () => pages[i++], delayMs: 0 })).toBeNull();
  });
  it("returns null when the catalogue looks truncated", async () => {
    const pages = [page(0, MIN_COMPETITOR_SKUS - 1), []];
    let i = 0;
    expect(await fetchCompetitorPrices({ fetchPage: async () => pages[i++], delayMs: 0 })).toBeNull();
  });
});
