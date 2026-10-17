import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn() }));
vi.mock("@/lib/database", () => ({ setSetting: vi.fn() }));
const { runSiteHealth, extractCodes, internalLinks, inspectHtml, rotatingSample, funnelLine, STORE_URL } = await import("@/lib/site-health");
import type { SiteHealthDeps, Fetched } from "@/lib/site-health";

const good = (title = "Salon") =>
  `<html><head><meta name="description" content="Des meubles de salon livrés gratuitement partout au Canada"></head><body><h1>${title}</h1></body></html>`;

function deps(over: Partial<SiteHealthDeps> & { pages?: Record<string, Fetched | string>; templates?: Record<string, string>; discounts?: Record<string, string> } = {}): SiteHealthDeps {
  const pages: Record<string, Fetched | string> = {
    [`${STORE_URL}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${STORE_URL}/sitemap_collections_1.xml?from=1&amp;to=2</loc></sitemap><sitemap><loc>${STORE_URL}/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap><sitemap><loc>${STORE_URL}/en/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap></sitemapindex>`,
    [`${STORE_URL}/sitemap_collections_1.xml?from=1&to=2`]: `<urlset><url><loc>${STORE_URL}/collections/salon</loc></url></urlset>`,
    [`${STORE_URL}/sitemap_products_1.xml?from=1&to=2`]: `<urlset><url><loc>${STORE_URL}/products/sofa</loc><image:image><image:loc>https://cdn.shopify.com/x.jpg</image:loc></image:image></url></urlset>`,
    [`${STORE_URL}/`]: good("Accueil").replace("</body>", `<a href="/pages/financement">f</a><a href="/cart">c</a><a href="https://ameublodirect.ca/collections/salon?x=1">s</a></body>`),
    [`${STORE_URL}/en`]: good("Home").replace("</body>", `<a href="/en/policies/refund-policy">p</a></body>`),
    [`${STORE_URL}/collections/salon`]: good(),
    [`${STORE_URL}/products/sofa`]: good("Sofa"),
    [`${STORE_URL}/pages/financement`]: good("Financement"),
    ...over.pages,
  };
  const templates = over.templates ?? { m1: `<style>.a{color:#FAFAF8}</style><p style="color:#1B2A4A">Ton code : <b>BIENVENUE20</b></p>` };
  const klaviyo: Record<string, unknown> = {
    "/flows/?fields[flow]=name,status": { data: [{ id: "F1", attributes: { name: "Welcome Series", status: "live" } }, { id: "F2", attributes: { name: "Vieux", status: "draft" } }] },
    "/flows/F1/flow-actions/": { data: [{ id: "A1" }] },
    "/flow-actions/A1/flow-messages/": { data: Object.keys(templates).map((id) => ({ id })) },
    "/metrics/": { data: [{ id: "S", attributes: { name: "Submitted Search" } }, { id: "C", attributes: { name: "Checkout Started", integration: { name: "Shopify" } } }, { id: "O", attributes: { name: "Placed Order", integration: { name: "Shopify" } } }] },
  };
  for (const [id, html] of Object.entries(templates)) klaviyo[`/flow-messages/${id}/template/`] = { data: { attributes: { html } } };
  return {
    async fetchPage(url) {
      if (url.includes("/search/suggest.json")) {
        const q = new URL(url).searchParams.get("q");
        return { status: 200, url, text: JSON.stringify({ resources: { results: { products: q === "torchère" ? [] : [{ title: "x" }] } } }) };
      }
      const p = pages[url];
      if (p === undefined) return { status: 404, text: "", url };
      return typeof p === "string" ? { status: 200, text: p, url } : p;
    },
    async klaviyoGet(path) {
      if (path.startsWith("/events/")) return { data: [
        { id: "e1", attributes: { event_properties: { SearchQuery: "Torchère ", URL: `${STORE_URL}/search?q=torch` } } },
        { id: "e2", attributes: { event_properties: { SearchQuery: "sofa", URL: `${STORE_URL}/search?q=sofa` } } },
      ] } as never;
      return (klaviyo[path] ?? { data: [] }) as never;
    },
    async klaviyoPost(_path, body) {
      const id = (body as { data: { attributes: { metric_id: string } } }).data.attributes.metric_id;
      return { data: { attributes: { data: [{ measurements: { count: id === "C" ? [10, 15] : [12] } }] } } };
    },
    async discountStatus(code) { return (over.discounts ?? { BIENVENUE20: "ACTIVE" })[code] ?? null; },
    async umami() { return null; },
    now: () => new Date("2026-10-16T12:00:00Z"),
    ...over,
  };
}

describe("site-health helpers", () => {
  it("extractCodes reads codes from visible text only (hex colours in styles never match)", () => {
    expect(extractCodes(`<style>.x{color:#FAFAF8}</style><td bgcolor="FAFAF8">Code BIENVENUE10 — 10% · FALL25</td>`)).toEqual(["BIENVENUE10", "FALL25"]);
  });

  it("internalLinks keeps storefront paths, drops cart/account/policies in both languages and query strings", () => {
    const html = `<a href="/collections/a?page=2">a</a><a href="https://ameublodirect.ca/products/b#x">b</a><a href="/en/cart">c</a><a href="/en/policies/x">p</a><a href="//cdn.x/y">d</a><a href="https://facebook.com/x">e</a>`;
    expect(internalLinks(html)).toEqual([`${STORE_URL}/collections/a`, `${STORE_URL}/products/b`]);
  });

  it("inspectHtml counts h1 outside scripts/templates, needs a real meta description, spots Liquid errors", () => {
    expect(inspectHtml(good())).toEqual({ liquidError: null, hasMeta: true, h1: 1 });
    const bad = `<meta name="description" content="court"><h1>a</h1><template><h1>b</h1></template><h1>c</h1>Liquid error (line 4): x`;
    expect(inspectHtml(bad)).toEqual({ liquidError: "Liquid error (line 4): x", hasMeta: false, h1: 2 });
  });

  it("rotatingSample walks the whole list over the days", () => {
    const items = [1, 2, 3, 4, 5];
    expect(rotatingSample(items, 2, 0)).toEqual([1, 2]);
    expect(rotatingSample(items, 2, 1)).toEqual([3, 4]);
    expect(rotatingSample(items, 2, 2)).toEqual([5, 1]);
    expect(rotatingSample([1], 5, 3)).toEqual([1]);
  });

  it("funnelLine says what is known and the checkout → order rate", () => {
    expect(funnelLine({ days: 7, visitors: null, addToCartClicks: null, addedToCart: 3, checkoutStarted: 25, placedOrder: 12 })).toBe("7 j : 25 caisses commencées → 12 commandes (48 % des caisses)");
    expect(funnelLine({ days: 7, visitors: 900, addToCartClicks: 40, addedToCart: 3, checkoutStarted: 0, placedOrder: 0 })).toBe("7 j : 900 visiteurs → 40 clics « ajouter » → 0 caisses commencées → 0 commandes");
  });
});

describe("runSiteHealth", () => {
  it("a clean store is ok, with pages from sitemap + homepage links, codes checked, zero-result searches listed", async () => {
    const r = await runSiteHealth(deps());
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.pages.checked).toBe(5); // /, /en, collection, FR product (EN product sitemap skipped), /pages/financement
    expect(r.promoCodes).toEqual({ checked: ["BIENVENUE20"], dead: [] });
    expect(r.searches).toEqual({ tested: 2, zeroResults: [{ q: "torchère", count: 1 }] });
    expect(r.funnel).toMatchObject({ checkoutStarted: 25, placedOrder: 12, visitors: null });
  });

  it("an expired code in a live email, a broken link and a page without description are red", async () => {
    const r = await runSiteHealth(deps({
      templates: { m1: "<p>Code BIENVENUE10</p>" },
      discounts: { BIENVENUE10: "EXPIRED" },
      pages: {
        [`${STORE_URL}/pages/financement`]: { status: 404, text: "", url: "" },
        [`${STORE_URL}/collections/salon`]: `<h1>Salon</h1>`,
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      "1 page ou lien cassé : /pages/financement (HTTP 404)",
      "1 page sans description Google : /collections/salon",
      "le courriel « Welcome Series » donne le code BIENVENUE10, qui est EXPIRED dans Shopify — les clients se le font refuser",
    ]);
  });

  it("a throttled page is retried once and never reported as broken", async () => {
    let calls = 0;
    const d = deps();
    const base = d.fetchPage;
    d.fetchPage = async (url) => (url === `${STORE_URL}/collections/salon` && calls++ < 2 ? { status: 429, text: "", url } : base(url));
    const r = await runSiteHealth(d);
    expect(r.pages.broken).toEqual([]);
  });

  it("without Klaviyo configured the email checks are skipped, not failed", async () => {
    const r = await runSiteHealth(deps({ klaviyoGet: async () => null }));
    expect(r.promoCodes).toBeNull();
    expect(r.searches).toBeNull();
    expect(r.funnel).toBeNull();
    expect(r.ok).toBe(true);
  });
});
