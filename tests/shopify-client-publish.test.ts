/**
 * Publication + metafield + product-state paths of shopify-client.
 *
 * None of these had a test, despite publishShopifyProduct/fetchProductPublishStates being
 * the whole of publish-reconcile (up to 67 products put live per run), setProductMetafield
 * carrying the English title/body written by the daily sync, and getShopifyStockState /
 * fetchDraftProductStates driving the intraday stock-check cron.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Token presence is a per-test switch rather than a doMock/doUnmock dance: unmocking
// mid-file makes every later vi.resetModules() reload the REAL config, which throws.
let hasToken = true;
vi.mock("@/lib/config", () => ({
  env: {
    get shopifyAccessToken() { return hasToken ? "test-token" : ""; },
    get hasShopifyToken() { return hasToken; },
  },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  SYNC: { MIN_DISCOUNT_DISPLAY_PERCENT: 10 },
}));

function res(
  body: unknown,
  init: { status?: number; link?: string | null; text?: string } = {},
) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "Link" ? (init.link ?? null) : null) },
    json: async () => body,
    text: async () => init.text ?? JSON.stringify(body),
  };
}

async function load() {
  vi.resetModules();
  return import("@/lib/shopify-client");
}

function endpoint(n: number): string {
  return String(mockFetch.mock.calls[n][0]).replace(
    "https://test.myshopify.com/admin/api/2025-01",
    "",
  );
}
function bodyOf(n: number): Record<string, unknown> {
  return JSON.parse(String(mockFetch.mock.calls[n][1].body));
}

beforeEach(() => {
  mockFetch.mockReset();
  hasToken = true;
});

describe("publishShopifyProduct", () => {
  it("sets published:true and leaves status alone by default", async () => {
    const { publishShopifyProduct } = await load();
    mockFetch.mockResolvedValue(res({ product: { id: 1 } }));

    await publishShopifyProduct("1");

    expect(endpoint(0)).toBe("/products/1.json");
    expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    // `published` is the field that puts a product on the Online Store. Flipping only
    // `status` to active does NOT publish an existing product — that is the gap
    // publish-reconcile exists to close, so status must not be touched implicitly.
    expect(bodyOf(0)).toEqual({ product: { id: "1", published: true } });
  });

  it("also activates when asked, for a product that is still a draft", async () => {
    const { publishShopifyProduct } = await load();
    mockFetch.mockResolvedValue(res({ product: { id: 1 } }));

    await publishShopifyProduct("1", { activate: true });

    expect(bodyOf(0)).toEqual({ product: { id: "1", published: true, status: "active" } });
  });

  it("throws with the status and body when Shopify refuses", async () => {
    const { publishShopifyProduct } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 422, text: "cannot publish archived product" }));

    await expect(publishShopifyProduct("1")).rejects.toThrow(
      /publish failed: 422 — cannot publish archived product/,
    );
  });
});

describe("fetchProductPublishStates", () => {
  it("treats a past published_at as published and a null one as not", async () => {
    const { fetchProductPublishStates } = await load();
    mockFetch.mockResolvedValue(
      res({
        products: [
          { id: 1, status: "active", published_at: "2020-01-01T00:00:00Z", tags: "a, b" },
          { id: 2, status: "active", published_at: null, tags: "" },
        ],
      }),
    );

    const out = await fetchProductPublishStates();

    expect(out).toEqual([
      { shopifyId: "1", status: "active", published: true, tags: ["a", "b"] },
      { shopifyId: "2", status: "active", published: false, tags: [] },
    ]);
  });

  it("treats a FUTURE published_at as not yet published", async () => {
    const { fetchProductPublishStates } = await load();
    mockFetch.mockResolvedValue(
      res({ products: [{ id: 3, status: "active", published_at: "2099-01-01T00:00:00Z", tags: "" }] }),
    );

    // A scheduled-for-later product is not on the storefront yet; counting it as
    // published would make publish-reconcile skip a product that needs publishing.
    expect((await fetchProductPublishStates())[0].published).toBe(false);
  });

  it("defaults a missing status to active", async () => {
    const { fetchProductPublishStates } = await load();
    mockFetch.mockResolvedValue(res({ products: [{ id: 4, published_at: null, tags: "" }] }));

    expect((await fetchProductPublishStates())[0].status).toBe("active");
  });

  it("follows pagination until the Link header stops offering a next page", async () => {
    const { fetchProductPublishStates } = await load();
    mockFetch
      .mockResolvedValueOnce(
        res({ products: [{ id: 1, status: "active", published_at: null, tags: "" }] }, {
          link: '<https://test.myshopify.com/admin/api/2025-01/products.json?page_info=P2&limit=250>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(res({ products: [{ id: 2, status: "draft", published_at: null, tags: "" }] }));

    const out = await fetchProductPublishStates();

    expect(out.map((p) => p.shopifyId)).toEqual(["1", "2"]);
    expect(endpoint(1)).toContain("page_info=P2");
  });

  it("returns [] with no token rather than calling Shopify", async () => {
    hasToken = false;
    const { fetchProductPublishStates } = await load();

    expect(await fetchProductPublishStates()).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchDraftProductStates", () => {
  it("asks Shopify for drafts only, and splits the comma-joined tags", async () => {
    const { fetchDraftProductStates } = await load();
    mockFetch.mockResolvedValue(
      res({ products: [{ id: 9, tags: "auto-drafted, out-of-stock ,  " }] }),
    );

    const out = await fetchDraftProductStates();

    expect(endpoint(0)).toContain("status=draft");
    expect(out).toEqual([{ shopifyId: "9", tags: ["auto-drafted", "out-of-stock"] }]);
  });

  it("drops the status filter on follow-up pages (Shopify rejects it with page_info)", async () => {
    const { fetchDraftProductStates } = await load();
    mockFetch
      .mockResolvedValueOnce(
        res({ products: [{ id: 1, tags: "" }] }, {
          link: '<https://test.myshopify.com/admin/api/2025-01/products.json?page_info=D2&limit=250>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(res({ products: [{ id: 2, tags: "" }] }));

    await fetchDraftProductStates();

    expect(endpoint(0)).toContain("status=draft");
    expect(endpoint(1)).toContain("page_info=D2");
    expect(endpoint(1)).not.toContain("status=");
  });

  it("throws on a failed page rather than returning a partial catalogue", async () => {
    const { fetchDraftProductStates } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 500 }));

    await expect(fetchDraftProductStates()).rejects.toThrow(/draft fetch failed: 500/);
  });
});

describe("getShopifyStockState", () => {
  it("returns the status and normalized tags for one product", async () => {
    const { getShopifyStockState } = await load();
    mockFetch.mockResolvedValue(res({ product: { id: 5, status: "draft", tags: "x , y" } }));

    expect(await getShopifyStockState("5")).toEqual({ status: "draft", tags: ["x", "y"] });
    expect(endpoint(0)).toBe("/products/5.json?fields=id,status,tags");
  });

  it("returns null for a deleted product (404) instead of throwing", async () => {
    const { getShopifyStockState } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 404 }));

    expect(await getShopifyStockState("5")).toBeNull();
  });

  it("returns null when the payload carries no product", async () => {
    const { getShopifyStockState } = await load();
    mockFetch.mockResolvedValue(res({}));

    expect(await getShopifyStockState("5")).toBeNull();
  });

  it("throws on other HTTP failures — a 500 must not read as 'gone'", async () => {
    const { getShopifyStockState } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 500 }));

    await expect(getShopifyStockState("5")).rejects.toThrow(/product fetch failed: 500/);
  });
});

describe("setProductMetafield", () => {
  it("PUTs a single metafield on the product", async () => {
    const { setProductMetafield } = await load();
    mockFetch.mockResolvedValue(res({ product: { id: 3 } }));

    await setProductMetafield("3", "custom", "title_en", "single_line_text_field", "Grey chair");

    expect(endpoint(0)).toBe("/products/3.json");
    expect(bodyOf(0)).toEqual({
      product: {
        id: "3",
        metafields: [
          { namespace: "custom", key: "title_en", type: "single_line_text_field", value: "Grey chair" },
        ],
      },
    });
  });

  it("throws with the response body, which is where Shopify explains a 422", async () => {
    const { setProductMetafield } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 422, text: '{"errors":{"metafields":["value can\'t be blank"]}}' }));

    await expect(
      setProductMetafield("3", "custom", "title_en", "single_line_text_field", ""),
    ).rejects.toThrow(/set metafield failed: 422 — .*can't be blank/);
  });
});

describe("deleteProductMetafield", () => {
  it("looks the metafield up by namespace+key, then deletes each match", async () => {
    const { deleteProductMetafield } = await load();
    mockFetch
      .mockResolvedValueOnce(res({ metafields: [{ id: 77 }, { id: 78 }] }))
      .mockResolvedValueOnce(res({}))
      .mockResolvedValueOnce(res({}));

    await deleteProductMetafield("3", "custom", "title_en");

    expect(endpoint(0)).toBe("/products/3/metafields.json?namespace=custom&key=title_en");
    expect(endpoint(1)).toBe("/products/3/metafields/77.json");
    expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
    expect(endpoint(2)).toBe("/products/3/metafields/78.json");
  });

  it("is a no-op when the metafield is absent", async () => {
    const { deleteProductMetafield } = await load();
    mockFetch.mockResolvedValue(res({ metafields: [] }));

    await deleteProductMetafield("3", "custom", "title_en");

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("tolerates a 404 on the delete — already gone is the desired end state", async () => {
    const { deleteProductMetafield } = await load();
    mockFetch
      .mockResolvedValueOnce(res({ metafields: [{ id: 77 }] }))
      .mockResolvedValueOnce(res({}, { status: 404 }));

    await expect(deleteProductMetafield("3", "custom", "title_en")).resolves.toBeUndefined();
  });

  it("throws on a delete failure that is not a 404", async () => {
    const { deleteProductMetafield } = await load();
    mockFetch
      .mockResolvedValueOnce(res({ metafields: [{ id: 77 }] }))
      .mockResolvedValueOnce(res({}, { status: 403, text: "no write_products" }));

    await expect(deleteProductMetafield("3", "custom", "title_en")).rejects.toThrow(
      /delete metafield failed: 403 — no write_products/,
    );
  });

  it("throws when the lookup itself fails, rather than silently deleting nothing", async () => {
    const { deleteProductMetafield } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 500, text: "boom" }));

    await expect(deleteProductMetafield("3", "custom", "title_en")).rejects.toThrow(
      /list metafields failed: 500 — boom/,
    );
  });
});

describe("fetchAllCollections", () => {
  it("maps id/title/handle with the id as a string", async () => {
    const { fetchAllCollections } = await load();
    mockFetch.mockResolvedValue(
      res({ custom_collections: [{ id: 12, title: "Patio", handle: "patio" }] }),
    );

    expect(await fetchAllCollections()).toEqual([{ id: "12", title: "Patio", handle: "patio" }]);
  });

  it("returns [] on an HTTP failure — unlike its siblings, this one does not throw", async () => {
    const { fetchAllCollections } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 500 }));

    expect(await fetchAllCollections()).toEqual([]);
  });

  it("returns [] when the payload has no custom_collections key", async () => {
    const { fetchAllCollections } = await load();
    mockFetch.mockResolvedValue(res({}));

    expect(await fetchAllCollections()).toEqual([]);
  });
});
