import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  sql: [] as Array<{ sql: string; args?: unknown[] }>,
  pageRows: [] as Array<Record<string, unknown>>,
  queryRows: [] as Array<Record<string, unknown>>,
  prevRows: [] as Array<Record<string, unknown>>,
  last: "2026-10-06" as string | null,
  settings: {} as Record<string, string>,
  count: 0,
  maxDay: null as string | null,
}));

vi.mock("@/lib/database", () => ({
  getSetting: vi.fn(async (k: string) => state.settings[k] ?? null),
  setSetting: vi.fn(async (k: string, v: string) => {
    state.settings[k] = v;
  }),
  ensureSchema: vi.fn(async () => ({
    batch: async (stmts: Array<string | { sql: string; args?: unknown[] }>) => {
      for (const s of stmts) state.sql.push(typeof s === "string" ? { sql: s } : s);
      return [];
    },
    execute: async (q: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof q === "string" ? q : q.sql;
      const args = typeof q === "string" ? [] : (q.args ?? []);
      if (sql.includes("COUNT(*)")) return { rows: [{ n: state.count, d: state.maxDay }] };
      if (sql.includes("MAX(day)")) return { rows: [{ d: state.last }] };
      if (sql.includes("FROM gsc_query_daily")) return { rows: state.queryRows };
      if (sql.includes("FROM gsc_page_daily")) return { rows: args[1] === "2026-10-06" ? state.pageRows : state.prevRows };
      return { rows: [] };
    },
  })),
}));

import { checkGscHealth, classifyPage, getSeoSummary, latestFinalDay, syncGsc, totalsOf } from "@/lib/gsc-sync";
import type { GscConfig } from "@/lib/gsc-client";

const cfg: GscConfig = { clientEmail: "x@y", privateKey: "k", siteUrl: "sc-domain:ameublodirect.ca" };

beforeEach(() => {
  state.sql = [];
  state.pageRows = [];
  state.queryRows = [];
  state.prevRows = [];
  state.last = "2026-10-06";
  state.settings = {};
  state.count = 0;
  state.maxDay = null;
});

describe("classifyPage", () => {
  it("sorts URLs into the sections of the site", () => {
    expect(classifyPage("https://ameublodirect.ca/blogs/guides/comment-choisir-un-sofa")).toBe("Guides d'achat");
    expect(classifyPage("https://ameublodirect.ca/blogs/actualites/petit-salon")).toBe("Blogue");
    expect(classifyPage("https://ameublodirect.ca/blogs/blog/cozy-home")).toBe("Blogue");
    expect(classifyPage("https://ameublodirect.ca/products/arbre-a-chat")).toBe("Produits");
    expect(classifyPage("https://ameublodirect.ca/en/products/cat-tree")).toBe("Produits");
    expect(classifyPage("https://ameublodirect.ca/collections/salon")).toBe("Collections");
    expect(classifyPage("https://ameublodirect.ca/")).toBe("Accueil");
    expect(classifyPage("https://ameublodirect.ca/pages/a-propos")).toBe("Autre");
  });
});

describe("totalsOf", () => {
  it("weights the position by impressions and derives the click-through rate", () => {
    const t = totalsOf([{ clicks: 10, impressions: 100, position: 5 }, { clicks: 0, impressions: 300, position: 15 }]);
    expect(t).toEqual({ clicks: 10, impressions: 400, ctr: 0.025, position: 12.5 });
    expect(totalsOf([])).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });
});

describe("syncGsc", () => {
  it("does nothing, without error, when Search Console is not configured", async () => {
    const prev = { a: process.env.GSC_SERVICE_ACCOUNT_JSON, b: process.env.GSC_SITE_URL };
    delete process.env.GSC_SERVICE_ACCOUNT_JSON;
    delete process.env.GSC_SITE_URL;
    expect(await syncGsc()).toEqual({ configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL"] });
    if (prev.a) process.env.GSC_SERVICE_ACCOUNT_JSON = prev.a;
    if (prev.b) process.env.GSC_SITE_URL = prev.b;
  });

  it("re-imports the window: delete the range, then insert pages and queries", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      const body = JSON.parse(String(init?.body));
      calls.push(body.dimensions.join(","));
      const rows = body.dimensions[1] === "page"
        ? [{ keys: ["2026-10-05", "https://ameublodirect.ca/"], clicks: 4, impressions: 90, ctr: 0.04, position: 7.5 }]
        : [{ keys: ["2026-10-05", "salon de jardin"], clicks: 1, impressions: 20, ctr: 0.05, position: 12 }];
      return new Response(JSON.stringify({ rows }), { status: 200 });
    });
    // a real RSA key is not needed here: the token call is mocked, but signing still needs one
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const r = await syncGsc({ days: 7, now: new Date("2026-10-08T12:00:00Z"), config: { ...cfg, privateKey }, fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ configured: true, startDate: "2026-09-30", endDate: "2026-10-06", pageRows: 1, queryRows: 1 });
    expect(calls).toEqual(["date,page", "date,query"]);
    const sqls = state.sql.map((s) => s.sql);
    expect(sqls.some((s) => s.startsWith("DELETE FROM gsc_page_daily"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("DELETE FROM gsc_query_daily"))).toBe(true);
    expect(state.sql.filter((s) => s.sql.includes("INSERT OR REPLACE INTO gsc_page_daily"))).toHaveLength(1);
    expect(state.sql.find((s) => s.sql.includes("INTO gsc_query_daily"))?.args).toEqual(["2026-10-05", "salon de jardin", 1, 20, 12]);
  });

  it("uses the newest day Google has final data for (today minus 2)", () => {
    expect(latestFinalDay(new Date("2026-10-08T03:00:00Z"))).toBe("2026-10-06");
  });
});

describe("getSeoSummary", () => {
  it("is empty and flags 'not imported yet' when no day has been stored", async () => {
    state.last = null;
    const s = await getSeoSummary(28);
    expect(s.lastDay).toBeNull();
    expect(s.current.clicks).toBe(0);
  });

  it("compares the period with the one before, groups by section and lists content opportunities", async () => {
    state.pageRows = [
      { key: "https://ameublodirect.ca/blogs/guides/sofa", clicks: 12, impressions: 300, position: 6 },
      { key: "https://ameublodirect.ca/blogs/actualites/petit-salon", clicks: 0, impressions: 120, position: 14 },
      { key: "https://ameublodirect.ca/products/arbre-a-chat", clicks: 3, impressions: 60, position: 9 },
      { key: "https://ameublodirect.ca/blogs/blog/rare", clicks: 0, impressions: 5, position: 30 },
    ];
    state.prevRows = [{ key: "https://ameublodirect.ca/blogs/guides/sofa", clicks: 6, impressions: 200, position: 8 }];
    state.queryRows = [{ key: "sofa sectionnel", clicks: 5, impressions: 100, position: 7 }];
    const s = await getSeoSummary(28);
    expect(s.lastDay).toBe("2026-10-06");
    expect(s.current.clicks).toBe(15);
    expect(s.previous.clicks).toBe(6);
    expect(s.sections.map((x) => x.section)).toEqual(["Guides d'achat", "Produits", "Blogue"]);
    expect(s.topPages[0].page).toContain("/blogs/guides/sofa");
    expect(s.topQueries[0]).toMatchObject({ query: "sofa sectionnel", clicks: 5 });
    expect(s.contentOpportunities).toEqual([{ page: "https://ameublodirect.ca/blogs/actualites/petit-salon", impressions: 120, position: 14 }]);
  });
});

describe("checkGscHealth", () => {
  const at = (d: string) => new Date(d + "T12:00:00Z");

  it("stamps the connection date and treats an empty table inside the grace window as pending, not a problem", async () => {
    const h = await checkGscHealth(at("2026-10-08"));
    expect(state.settings.gsc_connected_since).toBe("2026-10-08");
    expect(h).toMatchObject({ ok: true, pending: true, problems: [], pageRows: 0 });
    expect(await checkGscHealth(at("2026-10-10"))).toMatchObject({ ok: true, pending: true });
  });

  it("flags a property that is still empty after the grace window", async () => {
    state.settings.gsc_connected_since = "2026-10-08";
    const h = await checkGscHealth(at("2026-10-12"));
    expect(h.ok).toBe(false);
    expect(h.problems[0]).toContain("aucune donnée");
  });

  it("is healthy when rows are flowing and flags an import that stopped advancing", async () => {
    state.settings.gsc_connected_since = "2026-10-01";
    state.count = 120;
    state.maxDay = "2026-10-10";
    expect(await checkGscHealth(at("2026-10-12"))).toMatchObject({ ok: true, pending: false, lastDay: "2026-10-10" });
    state.maxDay = "2026-10-01";
    const stale = await checkGscHealth(at("2026-10-12"));
    expect(stale.ok).toBe(false);
    expect(stale.problems[0]).toContain("n'avancent plus");
  });
});
