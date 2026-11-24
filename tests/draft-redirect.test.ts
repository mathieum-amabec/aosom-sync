import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn() }));

import { shopifyFetch } from "@/lib/shopify-client";
import {
  rankCandidateCollections,
  searchFallback,
  shouldRedirect,
  ensureDraftRedirect,
  redirectOnDraft,
  runDraftRedirectReconcile,
  _resetInlineBudget,
  _setRateLimitMs,
  INLINE_BUDGET,
  INLINE_TIMEOUT_MS,
} from "@/lib/draft-redirect";

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: init.headers });

type Coll = { handle: string; count: number; active: number };

/** Fake Shopify Admin: one product + its collections, an existing-redirect table, and a POST log. */
function fakeShopify(opts: {
  product?: { handle: string; title: string; status: string; productType?: string; tags?: string[]; collections: Coll[] } | null;
  existing?: Record<string, string>;
  postErrorFor?: string[];
  drafts?: { id: string; handle: string; title: string; status: string; productType: string | null; tags: string[] }[];
}) {
  const posts: { path: string; target: string }[] = [];
  vi.mocked(shopifyFetch).mockImplementation(async (endpoint: string, init?: RequestInit) => {
    if (endpoint === "/graphql.json") {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("product(id:")) {
        const p = opts.product;
        return json({
          data: {
            product: p
              ? {
                  handle: p.handle, title: p.title, status: p.status, productType: p.productType ?? "Sofas", tags: p.tags ?? [],
                  collections: { nodes: p.collections.map((c) => ({ handle: c.handle, productsCount: { count: c.count } })) },
                }
              : null,
          },
        });
      }
      if (query.includes("collectionByHandle")) {
        const c = opts.product?.collections.find((x) => x.handle === variables.h);
        const nodes = Array.from({ length: c?.active ?? 0 }, () => ({ status: "ACTIVE" }));
        return json({ data: { collectionByHandle: c ? { products: { nodes } } : null } });
      }
      if (query.includes('status:draft')) {
        return json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts.drafts ?? [] } } });
      }
    }
    if (endpoint.startsWith("/redirects.json?path=")) {
      const path = decodeURIComponent(endpoint.split("path=")[1].split("&")[0]);
      const t = opts.existing?.[path];
      return json({ redirects: t ? [{ path, target: t }] : [] });
    }
    if (endpoint.startsWith("/redirects.json?limit=")) {
      return json({ redirects: Object.keys(opts.existing ?? {}).map((path) => ({ path })) });
    }
    if (endpoint === "/redirects.json" && init?.method === "POST") {
      const { redirect } = JSON.parse(String(init.body));
      if (opts.postErrorFor?.includes(redirect.target)) return json({ errors: { target: ["can't redirect to another redirect"] } }, { status: 422 });
      posts.push(redirect);
      return json({ redirect: { id: 1, ...redirect } }, { status: 201 });
    }
    throw new Error("unexpected " + endpoint);
  });
  return posts;
}

beforeEach(() => {
  _setRateLimitMs(0);
  vi.mocked(shopifyFetch).mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  _resetInlineBudget();
  delete process.env.DRAFT_REDIRECT_INLINE;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pure helpers", () => {
  it("ranks the most specific non-promo collection first", () => {
    const r = rankCandidateCollections([
      { handle: "meubles-salon", productsCount: 378 },
      { handle: "rabais", productsCount: 900 },
      { handle: "salon-canapes-3-places", productsCount: 27 },
      { handle: "nouveaux-arrivages", productsCount: 12 },
      { handle: "tiny", productsCount: 2 },
      { handle: "suivi-source-c", productsCount: 9 },
      { handle: "collection-de-printemps", productsCount: 5 },
      { handle: "rabais-lifestyle", productsCount: 6 },
    ]);
    expect(r.map((c) => c.handle)).toEqual(["salon-canapes-3-places", "meubles-salon"]);
  });

  it("builds a search fallback from the title", () => {
    expect(searchFallback("Divan 3 places en chenille « nuage »")).toBe("/search?q=Divan%20places%20chenille%20nuage");
    expect(searchFallback("!!")).toBe("/collections/all");
  });

  it("only redirects customer-facing drafts", () => {
    expect(shouldRedirect({ status: "DRAFT", tags: ["auto-drafted"] })).toBe(true);
    expect(shouldRedirect({ status: "draft", tags: [] })).toBe(true);
    expect(shouldRedirect({ status: "ACTIVE", tags: [] })).toBe(false);
    expect(shouldRedirect({ status: "ARCHIVED", tags: [] })).toBe(true);
    expect(shouldRedirect({ status: "DRAFT", tags: ["needs-review"] })).toBe(false);
    expect(shouldRedirect({ status: "DRAFT", tags: ["internal-warranty"] })).toBe(false);
  });
});

describe("ensureDraftRedirect", () => {
  const sofa = {
    handle: "divan-3-places", title: "Divan 3 places chenille", status: "DRAFT",
    collections: [
      { handle: "meubles-salon", count: 378, active: 50 },
      { handle: "salon-canapes-3-places", count: 27, active: 20 },
      { handle: "rabais", count: 900, active: 50 },
    ],
  };

  it("creates a redirect to the most specific collection", async () => {
    const posts = fakeShopify({ product: sofa });
    const out = await ensureDraftRedirect("123");
    expect(out).toEqual({ status: "created", path: "/products/divan-3-places", target: "/collections/salon-canapes-3-places" });
    expect(posts).toEqual([{ path: "/products/divan-3-places", target: "/collections/salon-canapes-3-places" }]);
  });

  it("never overrides an existing redirect", async () => {
    const posts = fakeShopify({ product: sofa, existing: { "/products/divan-3-places": "/collections/x" } });
    const out = await ensureDraftRedirect("123");
    expect(out.status).toBe("exists");
    expect(posts).toHaveLength(0);
  });

  it("skips a collection with too few ACTIVE products (all out-of-season drafts)", async () => {
    const posts = fakeShopify({
      product: { ...sofa, collections: [{ handle: "halloween", count: 37, active: 1 }, { handle: "noel-decorations", count: 48, active: 30 }] },
    });
    const out = await ensureDraftRedirect("123");
    expect(out).toMatchObject({ status: "created", target: "/collections/noel-decorations" });
    expect(posts).toHaveLength(1);
  });

  it("skips a target that does not render 200 on the storefront", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response("", { status: String(url).includes("salon-canapes-3-places") ? 301 : 200 })));
    fakeShopify({ product: sofa });
    const out = await ensureDraftRedirect("123");
    expect(out).toMatchObject({ status: "created", target: "/collections/meubles-salon" });
  });

  it("moves on when Shopify rejects the target, then falls back to search", async () => {
    const posts = fakeShopify({
      product: { ...sofa, collections: [{ handle: "chats", count: 156, active: 40 }] },
      postErrorFor: ["/collections/chats"],
    });
    const out = await ensureDraftRedirect("123");
    expect(out).toMatchObject({ status: "created", target: "/search?q=Divan%20places%20chenille" });
    expect(posts).toHaveLength(1);
  });

  it("does not touch active or review products", async () => {
    const posts = fakeShopify({ product: { ...sofa, status: "ACTIVE" } });
    expect((await ensureDraftRedirect("123")).status).toBe("skipped");
    fakeShopify({ product: { ...sofa, tags: ["needs-review"] } });
    expect((await ensureDraftRedirect("123")).status).toBe("skipped");
    expect(posts).toHaveLength(0);
  });

  it("dry-run plans without writing", async () => {
    const posts = fakeShopify({ product: sofa });
    const out = await ensureDraftRedirect("123", { apply: false });
    expect(out).toMatchObject({ status: "planned", target: "/collections/salon-canapes-3-places" });
    expect(posts).toHaveLength(0);
  });
});

describe("redirectOnDraft (inline hook)", () => {
  it("never throws when Shopify fails", async () => {
    vi.mocked(shopifyFetch).mockRejectedValue(new Error("boom"));
    await expect(redirectOnDraft("1")).resolves.toMatchObject({ status: "failed" });
  });

  it("is bounded by the inline budget", async () => {
    fakeShopify({ product: { handle: "x", title: "x", status: "ACTIVE", collections: [] } });
    for (let i = 0; i < INLINE_BUDGET; i++) await redirectOnDraft(String(i));
    await expect(redirectOnDraft("over")).resolves.toMatchObject({ status: "skipped" });
  });

  it("gives up after INLINE_TIMEOUT_MS so a slow Shopify cannot stall the caller", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(shopifyFetch).mockImplementation(() => new Promise(() => {}));
      const p = redirectOnDraft("slow");
      await vi.advanceTimersByTimeAsync(INLINE_TIMEOUT_MS + 10);
      await expect(p).resolves.toMatchObject({ status: "skipped" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be disabled", async () => {
    process.env.DRAFT_REDIRECT_INLINE = "0";
    await expect(redirectOnDraft("1")).resolves.toBeNull();
    expect(shopifyFetch).not.toHaveBeenCalled();
  });
});

describe("runDraftRedirectReconcile", () => {
  it("only processes eligible drafts that lack a redirect, dry-run by default", async () => {
    const posts = fakeShopify({
      product: { handle: "b", title: "Produit B", status: "DRAFT", collections: [{ handle: "salon-x", count: 10, active: 10 }] },
      existing: { "/products/a": "/collections/y" },
      drafts: [
        { id: "gid://shopify/Product/1", handle: "a", title: "A", status: "DRAFT", productType: null, tags: [] },
        { id: "gid://shopify/Product/2", handle: "b", title: "B", status: "DRAFT", productType: null, tags: ["auto-drafted"] },
        { id: "gid://shopify/Product/3", handle: "c", title: "C", status: "DRAFT", productType: null, tags: ["needs-review"] },
      ],
    });
    const r = await runDraftRedirectReconcile();
    expect(r).toMatchObject({ dryRun: true, drafts: 3, eligible: 2, alreadyRedirected: 1, missing: 1, planned: 1, created: 0 });
    expect(posts).toHaveLength(0);
    const r2 = await runDraftRedirectReconcile({ apply: true, cap: 5 });
    expect(r2).toMatchObject({ created: 1, deferred: 0 });
    expect(posts).toEqual([{ path: "/products/b", target: "/collections/salon-x" }]);
  });
});
