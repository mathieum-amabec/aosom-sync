import { describe, it, expect } from "vitest";
import {
  buildCatalogWhere,
  parseBoolParam,
  LOW_STOCK_THRESHOLD,
  toFtsQuery,
  deriveSubCategoryOptions,
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
    // search contributes THREE args (name + sku + product_type), so order matters.
    expect(r.args).toEqual(["Chairs%", "%sofa%", "%sofa%", "%sofa%", 10, 100, LOW_STOCK_THRESHOLD]);
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
  it("joins multiple tokens into ONE quoted PHRASE with a trailing prefix operator", () => {
    // catalog-search-bedframe-gap (2026-09-17): the old implementation quoted each token
    // SEPARATELY ("canape"* "gris"*), which FTS5 reads as an implicit AND of two independent
    // prefix terms — matching rows where the words appear anywhere, in any order. Searching
    // "bed frame" returned 100 rows (12 real bed frames + 88 unrelated products that merely
    // contained both "bed" and "frame" somewhere, e.g. a raised garden BED with a steel
    // FRAME). Quoting the whole sequence as a phrase requires adjacency, cutting that same
    // search to 23 rows in production with no loss of the 12 real matches.
    expect(toFtsQuery("canape gris")).toBe('"canape gris"*');
  });

  it("still behaves as a single prefix term for a one-word query (unchanged recall)", () => {
    expect(toFtsQuery("canape")).toBe('"canape"*');
  });

  it("neutralises FTS5 operators so shopper text can never be a query injection", () => {
    // Raw MATCH input is a query language. Unquoted, each of these is either a syntax
    // error (throwing on a PUBLIC endpoint) or a semantic change the shopper never asked
    // for. Splitting on non-alphanumerics makes every one of them inert.
    for (const nasty of ['canape" OR name:*', "canape NEAR/2 gris", "canape*", "-canape", "^canape"]) {
      const q = toFtsQuery(nasty);
      expect(q).not.toBeNull();
      // The whole surviving token sequence is one quoted phrase; no bare operator escapes.
      expect(/^"[^"]*"\*$/.test(q!)).toBe(true);
    }
  });

  it("returns null when there is nothing searchable, so the caller keeps the LIKE path", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery("!!! ??? ***")).toBeNull();
  });

  it("caps the token count so a pasted paragraph cannot blow up the MATCH", () => {
    const q = toFtsQuery("un deux trois quatre cinq six sept huit neuf dix onze");
    // 8 tokens joined into one phrase, so exactly 7 interior spaces plus the trailing `*`.
    expect(q!.replace(/^"|"\*$/g, "").split(" ")).toHaveLength(8);
  });
});

describe("buildCatalogWhere search routing", () => {
  it("defaults to the unindexed LIKE (name, sku, AND product_type) so an unaware caller cannot change semantics", () => {
    const r = buildCatalogWhere({ search: "canape" });
    expect(r.where).toBe("WHERE (name LIKE ? OR sku LIKE ? OR product_type LIKE ?)");
    expect(r.args).toEqual(["%canape%", "%canape%", "%canape%"]);
  });

  it("routes through products_fts (sku, name, product_type) on searchMode 'fts'", () => {
    const r = buildCatalogWhere({ search: "canape gris", searchMode: "fts" });
    expect(r.where).toContain("products_fts MATCH ?");
    expect(r.where).not.toContain("LIKE");
    expect(r.args).toEqual(['"canape gris"*']);
  });

  it("falls back to LIKE when the term has no searchable token, even in fts mode", () => {
    // "???" yields no tokens; emitting `MATCH ''` would throw at query time.
    const r = buildCatalogWhere({ search: "???", searchMode: "fts" });
    expect(r.where).toContain("name LIKE ?");
    expect(r.args).toEqual(["%???%", "%???%", "%???%"]);
  });

  it("keeps placeholders and args in lockstep when fts is combined with other filters", () => {
    const r = buildCatalogWhere({ search: "table", searchMode: "fts", minPrice: 100, inStock: true });
    expect((r.where.match(/\?/g) || []).length).toBe(r.args.length);
  });
});

describe("FTS vs LIKE: the documented narrowing", () => {
  it("documents that FTS is token-prefix, not infix — the fallback is zero-result only", () => {
    // Pins the semantics the CHANGELOG measured on production: "table" under FTS does NOT
    // match "Adjustable", which the old LIKE did. If someone later makes toFtsQuery emit a
    // leading wildcard to "fix" this, they lose the index and this test says so.
    const q = toFtsQuery("table");
    expect(q).toBe('"table"*');
    expect(q).not.toContain("*table"); // a leading wildcard would defeat the FTS index
  });
});

describe("deriveSubCategoryOptions — catalog page subcategory dropdown", () => {
  // Same shape the API's `productTypes` field returns (product_type_counts, which already
  // stores every prefix level of the Aosom taxonomy path — see rebuildProductTypeCounts).
  const productTypes = [
    { type: "Home Furnishings", count: 3683 },
    { type: "Home Furnishings > Bedroom Furniture", count: 224 },
    { type: "Home Furnishings > Bedroom Furniture > Bed Frames", count: 19 },
    { type: "Home Furnishings > Bedroom Furniture > Mattresses", count: 9 },
    { type: "Home Furnishings > Living Room Furniture", count: 400 },
    { type: "Patio & Garden", count: 2000 },
    { type: "Patio & Garden > Lawn & Garden > Raised Garden Beds", count: 50 },
  ];

  it("returns nothing when no top-level category is selected", () => {
    expect(deriveSubCategoryOptions(productTypes, "")).toEqual([]);
  });

  it("returns only entries exactly one level below the selected category", () => {
    const subs = deriveSubCategoryOptions(productTypes, "Home Furnishings");
    expect(subs.map((s) => s.type)).toEqual([
      "Home Furnishings > Bedroom Furniture",
      "Home Furnishings > Living Room Furniture",
    ]);
  });

  it("goes one level deeper again when the selection is itself a subcategory", () => {
    const subs = deriveSubCategoryOptions(productTypes, "Home Furnishings > Bedroom Furniture");
    expect(subs.map((s) => s.type)).toEqual([
      "Home Furnishings > Bedroom Furniture > Bed Frames",
      "Home Furnishings > Bedroom Furniture > Mattresses",
    ]);
  });

  it("does not surface grandchild-level entries, keeping the dropdown flat", () => {
    // "Patio & Garden"'s only descendant here is 2 levels down — no 1-level child exists,
    // so nothing should render rather than skipping a level silently.
    expect(deriveSubCategoryOptions(productTypes, "Patio & Garden")).toEqual([]);
  });

  it("returns nothing for a leaf category with no children", () => {
    expect(deriveSubCategoryOptions(productTypes, "Home Furnishings > Living Room Furniture")).toEqual([]);
  });
});
