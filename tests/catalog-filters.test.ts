import { describe, it, expect } from "vitest";
import {
  buildCatalogWhere,
  parseBoolParam,
  LOW_STOCK_THRESHOLD,
  PRODUCT_HAS_DISCOUNT_SQL,
} from "@/lib/catalog-filters";

describe("buildCatalogWhere", () => {
  it("returns an empty clause when no filters are set", () => {
    const r = buildCatalogWhere({});
    expect(r.where).toBe("");
    expect(r.conditions).toEqual([]);
    expect(r.args).toEqual([]);
  });

  it("notImported filters on an empty shopify_product_id (no args)", () => {
    const r = buildCatalogWhere({ notImported: true });
    expect(r.where).toContain("shopify_product_id IS NULL");
    expect(r.where).toContain("shopify_product_id = ''");
    expect(r.args).toEqual([]);
  });

  it("lowStock uses qty < threshold and binds the threshold", () => {
    const r = buildCatalogWhere({ lowStock: true });
    expect(r.conditions).toContain("qty < ?");
    expect(r.args).toEqual([LOW_STOCK_THRESHOLD]);
    expect(LOW_STOCK_THRESHOLD).toBe(5);
  });

  it("withDiscount embeds the correlated last-price predicate (no args)", () => {
    const r = buildCatalogWhere({ withDiscount: true });
    expect(r.conditions).toContain(PRODUCT_HAS_DISCOUNT_SQL);
    expect(r.where).toContain("ROW_NUMBER()");
    expect(r.where).toContain("products.price");
    expect(r.args).toEqual([]);
  });

  it("keeps conditions and args in lockstep across mixed filters", () => {
    const r = buildCatalogWhere({
      productType: "Chairs",
      search: "sofa",
      minPrice: 10,
      maxPrice: 100,
      inStock: true,
      lowStock: true,
    });
    // search contributes TWO args (name + sku), so order matters.
    expect(r.args).toEqual(["Chairs%", "%sofa%", "%sofa%", 10, 100, LOW_STOCK_THRESHOLD]);
    expect(r.where.startsWith("WHERE ")).toBe(true);
    expect(r.where).toContain("qty > 0");
    // One `?` per arg.
    expect((r.where.match(/\?/g) ?? []).length).toBe(r.args.length);
  });

  it("composes multiple boolean filters with AND", () => {
    const r = buildCatalogWhere({ notImported: true, withDiscount: true, lowStock: true });
    expect(r.conditions).toHaveLength(3);
    // Note: the discount predicate itself contains " AND ", so assert the
    // join invariant rather than splitting the string.
    expect(r.where).toBe("WHERE " + r.conditions.join(" AND "));
  });
});

describe("parseBoolParam", () => {
  it("treats 'true' and '1' as true, everything else as false", () => {
    expect(parseBoolParam("true")).toBe(true);
    expect(parseBoolParam("1")).toBe(true);
    expect(parseBoolParam("false")).toBe(false);
    expect(parseBoolParam("")).toBe(false);
    expect(parseBoolParam(null)).toBe(false);
  });
});
