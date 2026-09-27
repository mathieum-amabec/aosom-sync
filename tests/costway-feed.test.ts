import { describe, it, expect } from "vitest";
import { parseCostwayCsv, validateCostwayFeed } from "@/lib/costway/feed";
import { planCostwaySync, costwayContentHash } from "@/lib/costway/sync";
import type { CostwayIndexRow } from "@/lib/costway/db";
import { csv } from "./fixtures/costway-csv";


describe("parseCostwayCsv", () => {
  it("keeps raw inch-quotes and HTML quotes inside values (the feed is never RFC-quoted)", () => {
    const res = parseCostwayCsv(
      csv({ Title: `73" Massage Table`, "Body (HTML)": `<p style="margin-top:15px;">13.5" x13"</p>` }),
    );
    expect(res.malformedRows).toBe(0);
    expect(res.variants).toHaveLength(1);
    expect(res.variants[0].title).toBe(`73" Massage Table`);
    expect(res.variants[0].bodyHtml).toBe(`<p style="margin-top:15px;">13.5" x13"</p>`);
  });

  it("does not merge a row into the next one when a value has an odd number of quotes", () => {
    const res = parseCostwayCsv(csv({ Title: `2" Mat`, "Variant SKU": "111_A" }, { "Variant SKU": "111_B" }));
    expect(res.variants.map((v) => v.sku)).toEqual(["111_A", "111_B"]);
  });

  it("maps fields, stock flag, numbers and top category", () => {
    const [v] = parseCostwayCsv(
      csv({ "1=In Stock|0=OOS": "0", "Price Drop": "97.5", Tag: "Drop Price", "US Inventory": "" }),
    ).variants;
    expect(v).toMatchObject({
      sku: "111_AB1", itemNo: "111", color: "Black", inStock: false, qty: 5, usQty: null, caQty: 2,
      price: 100, priceDrop: 97.5, compareAtPrice: 150, promoTag: "Drop Price",
      category: "Furniture > Chairs", topCategory: "Furniture",
    });
  });

  it("orders images by Image Position and drops blanks/duplicates", () => {
    const [v] = parseCostwayCsv(
      csv({ images: [["https://a/2.jpg", "2"], ["https://a/1.jpg", "1"], ["", ""], ["https://a/1.jpg", "3"]] }),
    ).variants;
    expect(v.images).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
  });

  it("skips (and counts) malformed, incomplete and duplicate lines", () => {
    const res = parseCostwayCsv(
      csv(
        { "Variant SKU": "111_A" },
        "only,three,fields",
        { "Variant SKU": "" },
        { "Variant SKU": "111_A" },
      ),
    );
    expect(res.variants).toHaveLength(1);
    expect(res).toMatchObject({ totalRows: 4, malformedRows: 1, incompleteRows: 1, duplicateRows: 1 });
  });

  it("throws when a required column is missing from the header", () => {
    expect(() => parseCostwayCsv("Handle,Title\nh,t\n")).toThrow(/missing column/);
  });
});

describe("validateCostwayFeed", () => {
  const withRows = (n: number) =>
    ({ variants: new Array(n), totalRows: n, malformedRows: 0, incompleteRows: 0, duplicateRows: 0 }) as never;

  it("rejects a feed under the absolute floor", () => {
    expect(() => validateCostwayFeed(withRows(100), null)).toThrow(/min 5000/);
  });
  it("rejects a feed that shrank under 70% of the last good sync", () => {
    expect(() => validateCostwayFeed(withRows(10_000), 20_000)).toThrow(/truncated/);
  });
  it("accepts a normal feed", () => {
    expect(() => validateCostwayFeed(withRows(20_000), 22_000)).not.toThrow();
  });
});

describe("planCostwaySync", () => {
  const [base] = parseCostwayCsv(csv({})).variants;
  const indexed = (over: Partial<CostwayIndexRow> = {}): CostwayIndexRow => ({
    contentHash: costwayContentHash(base), inStock: true, qty: 5, usQty: 3, caQty: 2, price: 100,
    priceDrop: null, compareAtPrice: 150, promoTag: "", removed: false, ...over,
  });

  it("inserts unknown SKUs", () => {
    const p = planCostwaySync([base], new Map());
    expect(p.inserted).toBe(1);
    expect(p.full).toHaveLength(1);
  });
  it("leaves identical rows alone", () => {
    const p = planCostwaySync([base], new Map([[base.sku, indexed()]]));
    expect(p).toMatchObject({ full: [], volatile: [], unchanged: 1, removed: [] });
  });
  it("uses the light update for stock/price-only changes", () => {
    const p = planCostwaySync([{ ...base, qty: 0, inStock: false, price: 90 }], new Map([[base.sku, indexed()]]));
    expect(p.full).toHaveLength(0);
    expect(p.volatile).toEqual([expect.objectContaining({ sku: base.sku, qty: 0, inStock: false, price: 90 })]);
  });
  it("rewrites the full row when content changed", () => {
    const p = planCostwaySync([{ ...base, title: "Nouveau titre" }], new Map([[base.sku, indexed()]]));
    expect(p.full).toHaveLength(1);
    expect(p.inserted).toBe(0);
  });
  it("revives a SKU that came back to the feed", () => {
    const p = planCostwaySync([base], new Map([[base.sku, indexed({ removed: true })]]));
    expect(p.volatile).toHaveLength(1);
  });
  it("flags SKUs that left the feed, once", () => {
    const p = planCostwaySync(
      [base],
      new Map([
        [base.sku, indexed()],
        ["gone", indexed()],
        ["already-gone", indexed({ removed: true })],
      ]),
    );
    expect(p.removed).toEqual(["gone"]);
  });
});

