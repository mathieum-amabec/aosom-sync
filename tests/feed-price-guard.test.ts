import { describe, it, expect } from "vitest";
import { carryForwardMissingPrices, parseFeedPrice, PRICE_COLUMN_LOST_SHARE } from "@/lib/feed-price-guard";
import { parseTsv } from "@/lib/csv-fetcher";
import type { AosomProduct } from "@/types/aosom";

const p = (sku: string, price: number): AosomProduct => ({ sku, price, qty: 10 }) as AosomProduct;

describe("parseFeedPrice", () => {
  it("reads plain, suffixed and formatted prices", () => {
    expect(parseFeedPrice("41.36")).toBe(41.36);
    expect(parseFeedPrice("41.36 CAD")).toBe(41.36);
    expect(parseFeedPrice("$1,299.00")).toBe(1299);
  });
  it("is 0 for anything without a positive number", () => {
    expect(parseFeedPrice("")).toBe(0);
    expect(parseFeedPrice(undefined)).toBe(0);
    expect(parseFeedPrice("N/A")).toBe(0);
    expect(parseFeedPrice("0")).toBe(0);
    expect(parseFeedPrice(-5)).toBe(0);
  });
});

describe("carryForwardMissingPrices", () => {
  const known = new Map([["A", { price: 46.99 }], ["B", { price: 154.99 }]]);

  it("keeps the last known price for a row the feed gives no price for", () => {
    const r = carryForwardMissingPrices([p("A", 0), p("B", 0)], known);
    expect(r.products.map((x) => x.price)).toEqual([46.99, 154.99]);
    expect(r.carried).toBe(2);
    expect(r.unknown).toBe(0);
    expect(r.missingShare).toBe(1);
  });

  it("never touches a row that has a price in the feed", () => {
    const r = carryForwardMissingPrices([p("A", 50)], known);
    expect(r.products[0].price).toBe(50);
    expect(r.carried).toBe(0);
  });

  it("leaves an unknown SKU at 0 and counts it", () => {
    const r = carryForwardMissingPrices([p("Z", 0)], known);
    expect(r.products[0].price).toBe(0);
    expect(r.unknown).toBe(1);
  });

  it("does not mutate its input", () => {
    const input = [p("A", 0)];
    carryForwardMissingPrices(input, known);
    expect(input[0].price).toBe(0);
  });

  it("handles an empty feed", () => {
    expect(carryForwardMissingPrices([], known).missingShare).toBe(0);
  });

  it("flags a feed that lost its price column", () => {
    const r = carryForwardMissingPrices([p("A", 0), p("B", 0), p("C", 10)], known);
    expect(r.missingShare).toBeGreaterThanOrEqual(PRICE_COLUMN_LOST_SHARE);
  });
});

describe("the 2026-10-15 feed (no public Price column)", () => {
  const header = ["SKU", "Image", "Name", "2B Product Price", "shiping_fee", "Category", "Qty", "Product_Type"].join("\t");
  const row = ["720-027V00YL", "http://x/1.jpg", "Cover", "41.36 CAD", "15.42", "Home", "22", "Home > Covers"].join("\t");

  it("never reads the wholesale price as the public price", () => {
    const [prod] = parseTsv(`${header}\n${row}\n`);
    expect(prod.sku).toBe("720-027V00YL");
    expect(prod.price).toBe(0);
  });

  it("reads a `Price` column given with a currency suffix", () => {
    const [prod] = parseTsv(`SKU\tName\tPrice\tQty\n720-027V00YL\tCover\t46.99 CAD\t22\n`);
    expect(prod.price).toBe(46.99);
  });
});
