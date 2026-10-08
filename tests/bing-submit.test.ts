import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>>, inserts: [] as unknown[][] }));
vi.mock("@/lib/database", () => ({
  ensureSchema: vi.fn(async () => ({
    execute: async (q: string) => (q.includes("SELECT") ? { rows: state.sent } : { rows: [] }),
    batch: async (stmts: Array<{ args: unknown[] }>) => {
      for (const s of stmts) state.inserts.push(s.args);
      return [];
    },
  })),
}));

import { collectSitemapUrls, parseSitemapIndex, parseUrlset, pickToSubmit, readBingKey, submitToBing } from "@/lib/bing-submit";

const INDEX = `<sitemapindex><sitemap><loc>https://ameublodirect.ca/sitemap_agentic_discovery.xml</loc></sitemap>
<sitemap><loc>https://ameublodirect.ca/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap></sitemapindex>`;
const PRODUCTS = `<urlset>
<url><loc>https://ameublodirect.ca/products/a</loc><lastmod>2026-10-08T10:00:00Z</lastmod></url>
<url><loc>https://ameublodirect.ca/products/b</loc><lastmod>2026-09-01T10:00:00Z</lastmod></url>
<url><loc>https://ameublodirect.ca/products/c</loc></url>
<url><loc>https://other.example/x</loc></url>
</urlset>`;

beforeEach(() => {
  state.sent = [];
  state.inserts = [];
});

describe("sitemap parsing", () => {
  it("reads child sitemaps (skipping agentic discovery) and urls with optional lastmod", () => {
    expect(parseSitemapIndex(INDEX)).toEqual(["https://ameublodirect.ca/sitemap_products_1.xml?from=1&to=2"]);
    expect(parseUrlset(PRODUCTS)).toHaveLength(4);
    expect(parseUrlset(PRODUCTS)[2]).toEqual({ url: "https://ameublodirect.ca/products/c", lastmod: null });
  });
});

describe("pickToSubmit", () => {
  const e = (u: string, lastmod: string | null) => ({ url: u, lastmod });
  it("sends unseen urls newest first and respects the limit", () => {
    const got = pickToSubmit([e("a", "2026-01-01"), e("b", "2026-03-01"), e("c", "2026-02-01")], new Map(), 2);
    expect(got.map((x) => x.url)).toEqual(["b", "c"]);
  });
  it("skips urls already sent, but resends one that changed since", () => {
    const sent = new Map([
      ["a", { submittedAt: "t", lastmod: "2026-01-01" }],
      ["b", { submittedAt: "t", lastmod: "2026-01-01" }],
    ]);
    expect(pickToSubmit([e("a", "2026-01-01"), e("b", "2026-02-01"), e("c", null)], sent, 10).map((x) => x.url)).toEqual(["b", "c"]);
  });
  it("sends nothing when the quota is 0", () => {
    expect(pickToSubmit([e("a", null)], new Map(), 0)).toEqual([]);
  });
});

function fakeFetch(quota: number, submitStatus = 200) {
  const posts: Array<{ siteUrl: string; urlList: string[] }> = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("GetUrlSubmissionQuota")) return new Response(JSON.stringify({ d: { DailyQuota: quota, MonthlyQuota: 2400 } }), { status: 200 });
    if (u.includes("SubmitUrlbatch")) {
      if (submitStatus !== 200) return new Response(JSON.stringify({ Message: "ERROR!!! Quota exceeded" }), { status: submitStatus });
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ d: null }), { status: 200 });
    }
    if (u.endsWith("/sitemap.xml")) return new Response(INDEX, { status: 200 });
    if (u.includes("sitemap_products_1")) return new Response(PRODUCTS, { status: 200 });
    return new Response("nope", { status: 404 });
  });
  return { f: f as unknown as typeof fetch, posts };
}

describe("submitToBing", () => {
  it("is a no-op without a key", async () => {
    expect(readBingKey({})).toBeNull();
    expect(await submitToBing({ env: {} })).toEqual({ configured: false });
  });

  it("only keeps our own urls from the sitemap", async () => {
    const { f } = fakeFetch(100);
    expect((await collectSitemapUrls(f)).map((x) => x.url)).toEqual([
      "https://ameublodirect.ca/products/a",
      "https://ameublodirect.ca/products/b",
      "https://ameublodirect.ca/products/c",
    ]);
  });

  it("submits within the quota, newest first, and records what it sent", async () => {
    const { f, posts } = fakeFetch(2);
    const r = await submitToBing({ env: { BING_WEBMASTER_API_KEY: "k" }, fetchImpl: f, now: new Date("2026-10-08T12:00:00Z") });
    expect(r).toEqual({ configured: true, quota: 2, candidates: 3, submitted: 2, remaining: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].siteUrl).toBe("https://ameublodirect.ca");
    expect(posts[0].urlList).toEqual(["https://ameublodirect.ca/products/a", "https://ameublodirect.ca/products/b"]);
    expect(state.inserts.map((a) => a[0])).toEqual(posts[0].urlList);
  });

  it("does not resend what Bing already has", async () => {
    state.sent = [
      { url: "https://ameublodirect.ca/products/a", submitted_at: "t", lastmod: "2026-10-08T10:00:00Z" },
      { url: "https://ameublodirect.ca/products/b", submitted_at: "t", lastmod: "2026-09-01T10:00:00Z" },
    ];
    const { f, posts } = fakeFetch(100);
    const r = await submitToBing({ env: { BING_WEBMASTER_API_KEY: "k" }, fetchImpl: f });
    expect(posts[0].urlList).toEqual(["https://ameublodirect.ca/products/c"]);
    expect(r.remaining).toBe(0);
  });

  it("surfaces Bing's refusal and records nothing", async () => {
    const { f } = fakeFetch(100, 400);
    await expect(submitToBing({ env: { BING_WEBMASTER_API_KEY: "k" }, fetchImpl: f })).rejects.toThrow(/Quota exceeded/);
    expect(state.inserts).toHaveLength(0);
  });
});
