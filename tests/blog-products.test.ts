import { describe, it, expect, vi } from "vitest";
import {
  buildProductPicksHtml,
  buildProductPromptContext,
  chooseProducts,
  factsLine,
  fetchCollectionProducts,
  toBlogProduct,
  unwrapUnknownCollectionLinks,
  unwrapUnknownProductLinks,
  type BlogProduct,
} from "@/lib/blog-products";
import { contentRuleProblems } from "@/lib/blog-quality";

const P = (handle: string, over: Partial<BlogProduct> = {}): BlogProduct => ({
  handle,
  titleFr: `Produit ${handle}`,
  titleEn: `Product ${handle}`,
  imageUrl: `https://cdn.shopify.com/s/files/${handle}.jpg`,
  factsFr: "Un fait utile.",
  factsEn: "A useful fact.",
  ...over,
});

/** A GraphQL product node as Shopify returns it. */
const node = (over: Record<string, unknown> = {}) => ({
  handle: "sapin-floque-2-m",
  title: "Sapin de Noël floqué 2 m",
  status: "ACTIVE",
  onlineStoreUrl: "https://ameublodirect.ca/products/sapin-floque-2-m",
  productType: "Sapins",
  tags: [],
  description: "Un sapin enneigé au look réaliste, livré avec sa base. Seulement 199,99 $ cette semaine!",
  featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/s/files/sapin.jpg", altText: "Sapin" } } },
  variants: { nodes: [{ availableForSale: true }] },
  translations: [
    { key: "title", value: "Flocked Christmas Tree 2 m" },
    { key: "body_html", value: "<p>A snowy, realistic tree with its stand. Save 20% today.</p>" },
  ],
  ...over,
});

describe("toBlogProduct — only sellable, presentable products", () => {
  it("maps an active, published, available product with its EN title", () => {
    const p = toBlogProduct(node())!;
    expect(p.handle).toBe("sapin-floque-2-m");
    expect(p.titleFr).toBe("Sapin de Noël floqué 2 m");
    expect(p.titleEn).toBe("Flocked Christmas Tree 2 m");
    expect(p.imageUrl).toBe("https://cdn.shopify.com/s/files/sapin.jpg");
  });

  it("never carries a price or a percentage in the facts", () => {
    const p = toBlogProduct(node())!;
    expect(p.factsFr).not.toMatch(/\$|\d+\s?%/);
    expect(p.factsEn ?? "").not.toMatch(/\$|\d+\s?%/);
    expect(p.factsFr).toContain("sapin enneigé");
  });

  it.each([
    ["a draft", { status: "DRAFT" }],
    ["an unpublished product", { onlineStoreUrl: null }],
    ["a product with nothing in stock", { variants: { nodes: [{ availableForSale: false }] } }],
    ["the internal warranty product", { productType: "Garantie" }],
    ["a supplier-named title", { title: "Sapin Outsunny 2 m" }],
    ["a title with a price", { title: "Sapin 2 m à 99 $" }],
    ["a product without an image", { featuredMedia: null }],
    ["a malformed handle", { handle: "../admin" }],
  ])("rejects %s", (_label, over) => {
    expect(toBlogProduct(node(over))).toBeNull();
  });

  it("drops a supplier-named EN title (product then stays FR-only)", () => {
    const p = toBlogProduct(node({ translations: [{ key: "title", value: "HOMCOM Christmas Tree" }] }))!;
    expect(p.titleEn).toBeUndefined();
  });
});

describe("factsLine", () => {
  it("keeps the first sentence, strips supplier names, money and percentages", () => {
    expect(factsLine("Banc Aosom en bambou à 59,99 $ pour l'entrée. Deuxième phrase.")).toBe("Banc en bambou à pour l'entrée.");
    expect(factsLine("Save 15 % on this cozy bench.")).not.toMatch(/%/);
  });
  it("falls back to the product type", () => {
    expect(factsLine("", "Bancs")).toBe("Bancs");
  });
});

describe("chooseProducts", () => {
  const list = [P("jupe", { titleFr: "Jupe de sapin" }), P("a", { titleFr: "Sapin A" }), P("b", { titleFr: "Arbre de Noël B" }), P("c", { titleFr: "Guirlande" })];

  it("keeps matching products first, in best-selling order", () => {
    expect(chooseProducts(list, "^(sapin|arbre de no)", 6, 2).map((p) => p.handle)).toEqual(["a", "b"]);
  });

  it("tops up with other products when too few match", () => {
    expect(chooseProducts(list, "^sapin", 6, 3).map((p) => p.handle)).toEqual(["a", "jupe", "b"]);
  });

  it("caps at max and survives an invalid pattern", () => {
    expect(chooseProducts(list, "(", 2, 1)).toHaveLength(2);
  });

  it("dedupes identical titles (case-insensitive) before slicing, keeping the first (best seller)", () => {
    const dupes = [
      P("gris", { titleFr: "Banc coffre en velours" }),
      P("beige", { titleFr: "BANC COFFRE EN VELOURS " }),
      P("noir", { titleFr: "banc coffre en velours" }),
      P("autre", { titleFr: "Banc de rangement d'entrée" }),
    ];
    expect(chooseProducts(dupes, "^banc", 2, 1).map((p) => p.handle)).toEqual(["gris", "autre"]);
  });
});

describe("buildProductPicksHtml", () => {
  it("renders image, name and relative link for each product, plus the collection link (FR)", () => {
    const html = buildProductPicksHtml([P("sapin-a"), P("sapin-b")], "fr", "noel-sapins");
    expect(html).toContain("<h2>Nos suggestions</h2>");
    expect(html).toContain('href="/products/sapin-a"');
    expect(html).toContain('src="https://cdn.shopify.com/s/files/sapin-a.jpg"');
    expect(html).toContain("Produit sapin-b");
    expect(html).toContain('href="/collections/noel-sapins"');
    expect(html).not.toMatch(/https?:\/\/(?!cdn\.shopify\.com)/); // only the CDN image is absolute
  });

  it("uses the EN titles and heading for the EN article, skipping products without an EN title", () => {
    const html = buildProductPicksHtml([P("a"), P("b", { titleEn: undefined })], "en", "noel-sapins");
    expect(html).toContain("<h2>Our picks</h2>");
    expect(html).toContain("Product a");
    expect(html).not.toContain("/products/b");
    expect(html).toContain("See the whole collection");
  });

  it("escapes names (no HTML injection through a product title)", () => {
    const html = buildProductPicksHtml([P("a", { titleFr: `Table "pliante" <script>alert(1)</script>` })], "fr");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;pliante&quot;");
  });

  it("never renders a price and never a supplier name — the result passes the blog content guard", () => {
    const html = buildProductPicksHtml(
      [P("ok"), P("brand", { titleFr: "Arbre à chat PawHut 150 cm" }), P("price", { titleFr: "Banc 49,99 $" })],
      "fr",
      "arbres-a-chat",
    );
    expect(html).toContain("/products/ok");
    expect(html).not.toContain("/products/brand");
    expect(html).not.toContain("/products/price");
    expect(html).not.toMatch(/\$/);
    expect(contentRuleProblems({ title: "Titre de test assez long", bodyHtml: html })).toEqual([]);
  });

  it("is styled inline as a grid (no theme change) and shows at most 4 products", () => {
    const html = buildProductPicksHtml([P("a"), P("b"), P("c"), P("d"), P("e"), P("f")], "fr", "noel-sapins");
    expect(html).toContain(
      'style="list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px"',
    );
    expect(html).toContain('style="width:100%;height:auto"');
    expect((html.match(/<li>/g) ?? []).length).toBe(4);
    expect(html).not.toContain("/products/e");
    expect(contentRuleProblems({ title: "Titre de test assez long", bodyHtml: html })).toEqual([]);
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(buildProductPicksHtml([], "fr", "noel-sapins")).toBe("");
    expect(buildProductPicksHtml([P("a", { titleEn: undefined })], "en")).toBe("");
  });
});

describe("buildProductPromptContext", () => {
  it("lists names, relative URLs and facts — and no prices", () => {
    const ctx = buildProductPromptContext([P("sapin-a"), P("sapin-b")], "fr", "noel-sapins", ["noel-decorations"]);
    expect(ctx).toContain("- Produit sapin-a — /products/sapin-a — Un fait utile.");
    expect(ctx).toContain("/collections/noel-sapins");
    expect(ctx).toContain("/collections/noel-decorations");
    expect(ctx).toMatch(/never state or guess a price/i);
    expect(ctx).not.toMatch(/\d\s?\$/);
  });

  it("is empty without products", () => {
    expect(buildProductPromptContext([], "en", "noel-sapins")).toBe("");
  });
});

describe("unwrapUnknownProductLinks", () => {
  it("keeps links to given products and unwraps invented ones (text kept)", () => {
    const html = '<p>Voyez <a href="/products/real">ce sapin</a> ou <a href="/products/invented-123">celui-ci</a>, et <a href="/collections/noel-sapins">la collection</a>.</p>';
    const out = unwrapUnknownProductLinks(html, new Set(["real"]));
    expect(out).toContain('<a href="/products/real">ce sapin</a>');
    expect(out).not.toContain("invented-123");
    expect(out).toContain("celui-ci");
    expect(out).toContain('<a href="/collections/noel-sapins">');
  });
});

describe("unwrapUnknownCollectionLinks", () => {
  it("keeps the topic's (and related) collections, unwraps invented ones, accepts a /xx/ prefix", () => {
    const html =
      '<p><a href="/collections/noel-sapins">sapins</a>, <a href="/en/collections/noel-decorations">déco</a>, ' +
      '<a href="/collections/sapins-de-luxe">luxe</a>, <a href="/fr/collections/inventee?page=2">inventée</a>, ' +
      '<a href="/products/x">produit</a></p>';
    const out = unwrapUnknownCollectionLinks(html, new Set(["noel-sapins", "noel-decorations"]));
    expect(out).toContain('<a href="/collections/noel-sapins">sapins</a>');
    expect(out).toContain('<a href="/en/collections/noel-decorations">déco</a>');
    expect(out).not.toContain("sapins-de-luxe");
    expect(out).toContain("luxe");
    expect(out).not.toContain("/collections/inventee");
    expect(out).toContain("inventée");
    expect(out).toContain('<a href="/products/x">produit</a>'); // product links are not its job
  });

  it("with no allowed collection, every collection link is unwrapped", () => {
    expect(unwrapUnknownCollectionLinks('<a href="/collections/salon">salon</a>', new Set())).toBe("salon");
  });
});

describe("fetchCollectionProducts (Shopify mocked)", () => {
  const ok = (nodes: unknown[]) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { collectionByHandle: { products: { nodes } } } }), { status: 200 }));

  it("queries the collection by handle (read-only GraphQL) and returns the sellable products", async () => {
    const f = ok([node(), node({ handle: "draft-one", status: "DRAFT" }), node({ handle: "jupe-de-sapin", title: "Jupe de sapin" })]);
    const out = await fetchCollectionProducts("noel-sapins", { titlePattern: "^sapin" }, f);
    expect(f).toHaveBeenCalledTimes(1);
    const [endpoint, init] = f.mock.calls[0];
    expect(endpoint).toBe("/graphql.json");
    const body = JSON.parse(init.body);
    expect(body.variables).toEqual({ handle: "noel-sapins" });
    expect(body.query).not.toMatch(/mutation/i);
    expect(body.query).not.toMatch(/price/i);
    expect(out.map((p) => p.handle)).toEqual(["sapin-floque-2-m", "jupe-de-sapin"]); // matching first, then top-up
  });

  it("returns [] (never throws) on an HTTP error, a network error or an unknown collection", async () => {
    expect(await fetchCollectionProducts("noel-sapins", {}, vi.fn().mockResolvedValue(new Response("x", { status: 500 })))).toEqual([]);
    expect(await fetchCollectionProducts("noel-sapins", {}, vi.fn().mockRejectedValue(new Error("timeout")))).toEqual([]);
    expect(
      await fetchCollectionProducts("nope", {}, vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { collectionByHandle: null } })))),
    ).toEqual([]);
  });

  it("does not call Shopify for a malformed handle", async () => {
    const f = vi.fn();
    expect(await fetchCollectionProducts("../x", {}, f)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
