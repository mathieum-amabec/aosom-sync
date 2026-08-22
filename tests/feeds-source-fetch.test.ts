/**
 * The network-facing half of `lib/feeds/source.ts` — getFeedItems (the entry point every one
 * of the 7 feed routes calls), the two metafield fetchers, and scrubSupplier.
 *
 * feeds.test.ts covers the pure mapping helpers thoroughly; these four were the untested
 * remainder, and they are where a feed dies quietly: a truncated catalogue that still returns
 * 200 gets CDN-cached, and Google simply stops seeing the missing products.
 *
 * Only non-retryable statuses are exercised (404, not 429/5xx) — fetchWithRetry sleeps for
 * real on retryable ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/config", () => ({
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  env: { shopifyAccessToken: "test-token", hasShopifyToken: true },
}));

import {
  getFeedItems,
  fetchTitleEnMap,
  fetchMaterialMap,
  scrubSupplier,
  MATERIAL_METAFIELD_KEYS,
  type ShopifyFeedProduct,
} from "@/lib/feeds/source";

const MAX_PAGES = 80; // mirrors the constant in source.ts

function product(over: Partial<ShopifyFeedProduct> = {}): ShopifyFeedProduct {
  return {
    id: 1,
    title: "Chaise longue grise",
    handle: "chaise-longue-grise",
    vendor: "Ameublo Direct",
    status: "active",
    product_type: "Patio & Garden",
    body_html: "<p>Une chaise.</p>",
    published_at: "2020-01-01T00:00:00Z",
    images: [{ src: "https://cdn.shopify.com/x.jpg", position: 1 }],
    options: [],
    variants: [
      { id: 11, sku: "SKU-1", price: "99.99", compare_at_price: null, inventory_quantity: 5, title: "Default" },
    ],
    ...over,
  } as unknown as ShopifyFeedProduct;
}

/** REST products.json response, optionally advertising a next page. */
function restPage(products: ShopifyFeedProduct[], nextPageInfo?: string) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) =>
        h === "Link" && nextPageInfo
          ? `<https://test.myshopify.com/admin/api/2025-01/products.json?page_info=${nextPageInfo}&limit=250>; rel="next"`
          : null,
    },
    json: async () => ({ products }),
  };
}

/** GraphQL response. */
function gql(data: unknown, errors?: Array<{ message: string }>) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ data, errors }),
  };
}

function gqlProducts(nodes: Array<{ legacyResourceId: string; metafield: { value: string } | null }>, hasNextPage = false, endCursor: string | null = null) {
  return gql({ products: { pageInfo: { hasNextPage, endCursor }, nodes } });
}

/** No material metafield is defined on the store today — the common case. */
function noMaterialDefs() {
  return gql({ metafieldDefinitions: { nodes: [] } });
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.SHOPIFY_ACCESS_TOKEN = "test-token";
});
afterEach(() => {
  process.env.SHOPIFY_ACCESS_TOKEN = "test-token";
});

describe("scrubSupplier", () => {
  it("replaces every occurrence of the supplier name, case-insensitively", () => {
    expect(scrubSupplier("Aosom vous propose. AOSOM livre. aosom garantit."))
      .toBe("Ameublo Direct vous propose. Ameublo Direct livre. Ameublo Direct garantit.");
  });

  it("uses the locale's house brand, so an EN description never reads Ameublo Direct", () => {
    expect(scrubSupplier("Aosom ships fast", "Furnish Direct")).toBe("Furnish Direct ships fast");
  });

  it("matches on a word boundary and leaves a longer word intact", () => {
    expect(scrubSupplier("aosomatic")).toBe("aosomatic");
    expect(scrubSupplier("Meubles Aosom-Canada")).toBe("Meubles Ameublo Direct-Canada");
  });

  it("collapses the double space a mid-sentence replacement can leave behind", () => {
    expect(scrubSupplier("Vendu par  Aosom  au Canada")).toBe("Vendu par Ameublo Direct au Canada");
  });

  it("leaves copy with no supplier mention untouched", () => {
    expect(scrubSupplier("Chaise longue en rotin")).toBe("Chaise longue en rotin");
  });
});

describe("getFeedItems", () => {
  it("throws when no Shopify token is configured", async () => {
    delete process.env.SHOPIFY_ACCESS_TOKEN;

    await expect(getFeedItems()).rejects.toThrow(/SHOPIFY_ACCESS_TOKEN not configured/);
  });

  it("returns mapped feed items for a single page", async () => {
    mockFetch
      .mockResolvedValueOnce(restPage([product()]))
      .mockResolvedValueOnce(noMaterialDefs());

    const items = await getFeedItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "SKU-1", title: "Chaise longue grise" });
  });

  it("follows the Link header across pages and concatenates them", async () => {
    mockFetch
      .mockResolvedValueOnce(restPage([product({ id: 1, variants: [{ id: 11, sku: "A", price: "10.00", compare_at_price: null, inventory_quantity: 5, title: "d" }] as never })], "P2"))
      .mockResolvedValueOnce(restPage([product({ id: 2, variants: [{ id: 22, sku: "B", price: "20.00", compare_at_price: null, inventory_quantity: 5, title: "d" }] as never })]))
      .mockResolvedValueOnce(noMaterialDefs());

    const items = await getFeedItems();

    expect(items.map((i) => i.id)).toEqual(["A", "B"]);
    expect(String(mockFetch.mock.calls[1][0])).toContain("page_info=P2");
  });

  it("refuses to serve a partial catalogue when pagination runs past the page cap", async () => {
    // Every page advertises another one, so the cap is what stops the loop. Returning 200 with
    // a truncated feed would get CDN-cached for hours and quietly drop products from Google —
    // failing loud is the whole point.
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("graphql") ? noMaterialDefs() : restPage([product()], "ALWAYS_MORE"),
    );

    await expect(getFeedItems()).rejects.toThrow(/refusing to serve a partial feed/);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it("throws on a failed products fetch rather than returning what it has", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });

    await expect(getFeedItems()).rejects.toThrow(/products fetch failed: 404/);
  });

  it("overlays the material metafield onto the products when one is defined", async () => {
    const [materialKey] = MATERIAL_METAFIELD_KEYS;
    const [namespace, key] = materialKey.split(".");
    mockFetch
      .mockResolvedValueOnce(restPage([product({ id: 7 })]))
      .mockResolvedValueOnce(gql({ metafieldDefinitions: { nodes: [{ namespace, key }] } }))
      .mockResolvedValueOnce(gqlProducts([{ legacyResourceId: "7", metafield: { value: "Rotin" } }]));

    const items = await getFeedItems();

    expect(items[0].material).toBe("Rotin");
  });

  it("does not pay for the metafield pass when no material metafield is defined", async () => {
    mockFetch
      .mockResolvedValueOnce(restPage([product()]))
      .mockResolvedValueOnce(noMaterialDefs());

    await getFeedItems();

    // One REST page + exactly one cheap definitions probe, and no product pagination.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("overlays English titles and prefers them when asked", async () => {
    mockFetch
      .mockResolvedValueOnce(restPage([product({ id: 7 })]))
      .mockResolvedValueOnce(noMaterialDefs())
      .mockResolvedValueOnce(gqlProducts([{ legacyResourceId: "7", metafield: { value: "Grey lounge chair" } }]));

    const items = await getFeedItems({ english: true });

    expect(items[0].title).toBe("Grey lounge chair");
  });

  it("keeps the French title for a product with no English metafield", async () => {
    mockFetch
      .mockResolvedValueOnce(restPage([product({ id: 7 })]))
      .mockResolvedValueOnce(noMaterialDefs())
      .mockResolvedValueOnce(gqlProducts([]));

    const items = await getFeedItems({ english: true });

    expect(items[0].title).toBe("Chaise longue grise");
  });

  it("does not fetch English titles for the French feed", async () => {
    mockFetch
      .mockResolvedValueOnce(restPage([product()]))
      .mockResolvedValueOnce(noMaterialDefs());

    await getFeedItems();

    expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("graphql"))).toHaveLength(1);
  });
});

describe("fetchMaterialMap — must never take the feed down", () => {
  it("returns an empty map with no token, without calling Shopify", async () => {
    delete process.env.SHOPIFY_ACCESS_TOKEN;

    expect((await fetchMaterialMap()).size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops after the definitions probe when no material metafield exists", async () => {
    mockFetch.mockResolvedValueOnce(gql({ metafieldDefinitions: { nodes: [{ namespace: "custom", key: "title_en" }] } }));

    expect((await fetchMaterialMap()).size).toBe(0);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("paginates and maps values once a definition exists", async () => {
    const [namespace, key] = MATERIAL_METAFIELD_KEYS[0].split(".");
    mockFetch
      .mockResolvedValueOnce(gql({ metafieldDefinitions: { nodes: [{ namespace, key }] } }))
      .mockResolvedValueOnce(gqlProducts([{ legacyResourceId: "1", metafield: { value: "Acier" } }], true, "C2"))
      .mockResolvedValueOnce(gqlProducts([{ legacyResourceId: "2", metafield: { value: "Bois" } }]));

    const map = await fetchMaterialMap();

    expect(map.get("1")).toBe("Acier");
    expect(map.get("2")).toBe("Bois");
  });

  it("skips blank and whitespace-only values rather than emitting an empty attribute", async () => {
    const [namespace, key] = MATERIAL_METAFIELD_KEYS[0].split(".");
    mockFetch
      .mockResolvedValueOnce(gql({ metafieldDefinitions: { nodes: [{ namespace, key }] } }))
      .mockResolvedValueOnce(
        gqlProducts([
          { legacyResourceId: "1", metafield: { value: "   " } },
          { legacyResourceId: "2", metafield: null },
          { legacyResourceId: "3", metafield: { value: " Rotin " } },
        ]),
      );

    const map = await fetchMaterialMap();

    expect([...map.keys()]).toEqual(["3"]);
    expect(map.get("3")).toBe("Rotin");
  });

  it("swallows a GraphQL failure and returns empty — a missing material is not a dead feed", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    expect((await fetchMaterialMap()).size).toBe(0);
  });
});

describe("fetchTitleEnMap — must fail loud", () => {
  it("throws with no token", async () => {
    delete process.env.SHOPIFY_ACCESS_TOKEN;

    await expect(fetchTitleEnMap()).rejects.toThrow(/SHOPIFY_ACCESS_TOKEN not configured/);
  });

  it("surfaces GraphQL errors instead of returning a half-empty map", async () => {
    // Unlike material, an EN title is the whole point of the EN feed — degrading silently
    // would ship a French feed under an English brand.
    mockFetch.mockResolvedValueOnce(gql(null, [{ message: "Access denied for products field" }]));

    await expect(fetchTitleEnMap()).rejects.toThrow(/Access denied for products field/);
  });

  it("throws when the payload carries no products connection", async () => {
    mockFetch.mockResolvedValueOnce(gql({}));

    await expect(fetchTitleEnMap()).rejects.toThrow(/no products connection/);
  });

  it("follows the cursor and keeps only non-empty titles", async () => {
    mockFetch
      .mockResolvedValueOnce(
        gqlProducts(
          [
            { legacyResourceId: "1", metafield: { value: "Grey chair" } },
            { legacyResourceId: "2", metafield: { value: "  " } },
            { legacyResourceId: "3", metafield: null },
          ],
          true,
          "C2",
        ),
      )
      .mockResolvedValueOnce(gqlProducts([{ legacyResourceId: "4", metafield: { value: " Patio set " } }]));

    const map = await fetchTitleEnMap();

    expect([...map.entries()]).toEqual([
      ["1", "Grey chair"],
      ["4", "Patio set"],
    ]);
    expect(JSON.parse(String(mockFetch.mock.calls[1][1].body)).variables.cursor).toBe("C2");
  });
});
