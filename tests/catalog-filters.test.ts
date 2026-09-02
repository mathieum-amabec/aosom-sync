import { describe, it, expect } from "vitest";
import {
  buildCatalogWhere,
  parseBoolParam,
  LOW_STOCK_THRESHOLD,
  toFtsQuery,
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

  it("withDiscount uses the precomputed has_discount flag (no args)", () => {
    const r = buildCatalogWhere({ withDiscount: true });
    expect(r.conditions).toContain("has_discount = 1");
    expect(r.where).toContain("has_discount = 1");
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

describe("toFtsQuery — FTS5 MATCH construction", () => {
  it("quotes every token and appends the prefix operator outside the quotes", () => {
    expect(toFtsQuery("canape gris")).toBe('"canape"* "gris"*');
  });

  it("neutralises FTS5 operators so shopper text can never be a query injection", () => {
    // Raw MATCH input is a query language. Unquoted, each of these is either a syntax
    // error (throwing on a PUBLIC endpoint) or a semantic change the shopper never asked
    // for. Splitting on non-alphanumerics makes every one of them inert.
    for (const nasty of ['canape" OR name:*', "canape NEAR/2 gris", "canape*", "-canape", "^canape"]) {
      const q = toFtsQuery(nasty);
      expect(q).not.toBeNull();
      // Every surviving token is quoted; no bare operator escapes.
      expect(q!.split(" ").every((t) => /^"[^"]*"\*$/.test(t))).toBe(true);
    }
  });

  it("returns null when there is nothing searchable, so the caller keeps the LIKE path", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery("!!! ??? ***")).toBeNull();
  });

  it("caps the token count so a pasted paragraph cannot blow up the MATCH", () => {
    const q = toFtsQuery("un deux trois quatre cinq six sept huit neuf dix onze");
    expect(q!.split(" ")).toHaveLength(8);
  });
});

describe("buildCatalogWhere search routing", () => {
  it("defaults to the unindexed LIKE so an unaware caller cannot change semantics", () => {
    const r = buildCatalogWhere({ search: "canape" });
    expect(r.where).toContain("name LIKE ?");
    expect(r.args).toEqual(["%canape%", "%canape%"]);
  });

  it("routes through products_fts on searchMode 'fts'", () => {
    const r = buildCatalogWhere({ search: "canape gris", searchMode: "fts" });
    expect(r.where).toContain("products_fts MATCH ?");
    expect(r.where).not.toContain("LIKE");
    expect(r.args).toEqual(['"canape"* "gris"*']);
  });

  it("falls back to LIKE when the term has no searchable token, even in fts mode", () => {
    // "???" yields no tokens; emitting `MATCH ''` would throw at query time.
    const r = buildCatalogWhere({ search: "???", searchMode: "fts" });
    expect(r.where).toContain("name LIKE ?");
    expect(r.args).toEqual(["%???%", "%???%"]);
  });

  it("keeps placeholders and args in lockstep when fts is combined with other filters", () => {
    const r = buildCatalogWhere({ search: "table", searchMode: "fts", minPrice: 100, inStock: true });
    expect((r.where.match(/\?/g) || []).length).toBe(r.args.length);
  });
});
