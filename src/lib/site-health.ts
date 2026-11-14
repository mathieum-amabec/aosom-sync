/**
 * Daily read-only health check of the storefront and the email side of conversion.
 *
 * What it checks (and why each one exists):
 *   - pages: every collection and page in the sitemap, a rotating sample of products, and every
 *     internal link on the FR + EN homepages (menu, footer, sections). Broken status, Liquid errors,
 *     missing meta description, and not exactly one <h1> — the defects the 2026-10-16 manual audit
 *     of the redesign found and fixed by hand.
 *   - promo codes: every code-looking token in the LIVE Klaviyo flow emails must be an ACTIVE
 *     Shopify discount. Found 2026-10-16: the Welcome email kept sending BIENVENUE10 for two weeks
 *     after it expired, so every new subscriber got a code the checkout refused.
 *   - searches: the shoppers' real queries (Klaviyo "Submitted Search", last 7 days) are replayed
 *     against the store's predictive search; zero-result queries say which synonym or product is missing.
 *   - funnel: 7-day counts of Added to Cart / Checkout Started / Placed Order from Klaviyo (the
 *     Shopify metrics), plus Umami visitors and "Add to Cart" clicks when UMAMI_API_KEY is set.
 *     Shopify's own analytics need read_reports, which the app token does not have.
 *
 * NEVER writes anywhere except its own result (settings.site_health_audit). Dependencies are
 * injected so the logic is unit-tested without network.
 */
import { shopifyFetch } from "./shopify-client";
import { setSetting } from "./database";

export const STORE_URL = "https://ameublodirect.ca";
export const SETTINGS_KEY = "site_health_audit";
const PRODUCT_SAMPLE = 20;
/** ~108 collections ×2 languages + pages + product sample + homepage links ≈ 300 today. */
const MAX_PAGES = 450;
const MAX_QUERIES = 40;
const CONCURRENCY = 4;

export interface Fetched { status: number; text: string; url: string }
export interface SiteHealthDeps {
  fetchPage(url: string): Promise<Fetched>;
  /** Klaviyo GET (path relative to https://a.klaviyo.com/api), parsed JSON or null when unconfigured. */
  klaviyoGet(path: string): Promise<KlaviyoList | null>;
  klaviyoPost(path: string, body: unknown): Promise<unknown>;
  /** Shopify discount status for a code (ACTIVE, EXPIRED, SCHEDULED…) or null when no such code. */
  discountStatus(code: string): Promise<string | null>;
  umami(path: string): Promise<unknown | null>;
  now(): Date;
}
interface KlaviyoList { data?: Array<{ id: string; attributes?: Record<string, unknown>; relationships?: Record<string, unknown> }>; links?: { next?: string | null } }

export interface PageIssue { url: string; detail: string }
export interface SiteHealthResult {
  auditedAt: number;
  ok: boolean;
  reasons: string[];
  pages: { checked: number; skipped: number; broken: PageIssue[]; liquidErrors: PageIssue[]; missingMeta: string[]; badH1: PageIssue[] };
  promoCodes: { checked: string[]; dead: Array<{ code: string; status: string; flow: string }> } | null;
  searches: { tested: number; zeroResults: Array<{ q: string; count: number }> } | null;
  funnel: Funnel | null;
}
export interface Funnel {
  days: number;
  visitors: number | null;
  addToCartClicks: number | null;
  addedToCart: number;
  checkoutStarted: number;
  placedOrder: number;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&").trim());

/** Rotate through the products so every product gets checked over time, PRODUCT_SAMPLE a day. */
export function rotatingSample<T>(items: T[], size: number, day: number): T[] {
  if (items.length <= size) return items;
  const start = (day * size) % items.length;
  return Array.from({ length: size }, (_, k) => items[(start + k) % items.length]);
}

/** Internal links of a page, as absolute storefront URLs without query or hash. */
export function internalLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    let h = m[1].replace(/&amp;/g, "&").split("#")[0];
    if (h.startsWith("//")) continue;
    if (h.startsWith(STORE_URL)) h = h.slice(STORE_URL.length);
    if (!h.startsWith("/") || /^(\/en)?\/(cart|account|checkout|search|tools|apps|cdn|policies|customer_authentication)\b/.test(h) || h.includes("{{")) continue;
    out.add(STORE_URL + h.split("?")[0]);
  }
  return [...out];
}

export function inspectHtml(html: string): { liquidError: string | null; hasMeta: boolean; h1: number } {
  const le = html.match(/Liquid (?:syntax )?error[^<]{0,120}/i);
  const hasMeta = /<meta\s+name="description"\s+content="[^"]{20,}"/i.test(html);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<template[\s\S]*?<\/template>/gi, "");
  const h1 = (body.match(/<h1[\s>]/gi) || []).length;
  return { liquidError: le ? le[0] : null, hasMeta, h1 };
}

async function checkPages(deps: SiteHealthDeps): Promise<SiteHealthResult["pages"]> {
  const day = Math.floor(deps.now().getTime() / 86_400_000);
  const index = await deps.fetchPage(`${STORE_URL}/sitemap.xml`);
  const children = locs(index.text);
  const urls = new Set<string>([`${STORE_URL}/`, `${STORE_URL}/en`]);
  const products: string[] = [];
  for (const sm of children) {
    // Collections and pages in both languages; products from the FR sitemaps only (the sample rotates daily).
    if (/sitemap_(collections|pages)_/.test(sm)) locs((await deps.fetchPage(sm)).text).forEach((u) => urls.add(u));
    else if (/\/sitemap_products_\d+\.xml/.test(sm) && !sm.includes("/en/")) {
      products.push(...locs((await deps.fetchPage(sm)).text).filter((u) => u.includes("/products/")));
    }
  }
  rotatingSample(products, PRODUCT_SAMPLE, day).forEach((u) => urls.add(u));
  // Every internal link of both homepages (menu, footer, homepage sections).
  for (const home of [`${STORE_URL}/`, `${STORE_URL}/en`]) internalLinks((await deps.fetchPage(home)).text).forEach((u) => urls.add(u));

  const list = [...urls].slice(0, MAX_PAGES);
  const res: SiteHealthResult["pages"] = { checked: list.length, skipped: urls.size - list.length, broken: [], liquidErrors: [], missingMeta: [], badH1: [] };
  await pool(list, CONCURRENCY, async (url) => {
    let r = await deps.fetchPage(url);
    if (r.status === 429 || r.status >= 500) r = await deps.fetchPage(url); // one retry: Shopify throttles bursts
    if (r.status !== 200) { if (r.status !== 429) res.broken.push({ url, detail: `HTTP ${r.status}` }); return; }
    const i = inspectHtml(r.text);
    if (i.liquidError) res.liquidErrors.push({ url, detail: i.liquidError });
    if (!i.hasMeta) res.missingMeta.push(url);
    if (i.h1 !== 1) res.badH1.push({ url, detail: `${i.h1} h1` });
  });
  return res;
}

/** Code-looking tokens in the visible text of an email (styles and attributes stripped, so hex colours never match). */
export function extractCodes(html: string): string[] {
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return [...new Set([...text.matchAll(/\b([A-Z]{4,}[0-9]{1,3})\b/g)].map((m) => m[1]))];
}

async function klaviyoAll(deps: SiteHealthDeps, path: string, cap = 400) {
  const out: NonNullable<KlaviyoList["data"]> = [];
  let next: string | null = path;
  while (next && out.length < cap) {
    const page: KlaviyoList | null = await deps.klaviyoGet(next);
    if (!page) return null;
    out.push(...(page.data || []));
    next = page.links?.next ? page.links.next.replace("https://a.klaviyo.com/api", "") : null;
  }
  return out;
}

async function checkPromoCodes(deps: SiteHealthDeps): Promise<SiteHealthResult["promoCodes"]> {
  const flows = await klaviyoAll(deps, "/flows/?fields[flow]=name,status");
  if (!flows) return null;
  const seen = new Map<string, string>(); // code -> flow name
  for (const f of flows.filter((x) => x.attributes?.status === "live")) {
    const actions = (await klaviyoAll(deps, `/flows/${f.id}/flow-actions/`)) || [];
    for (const a of actions) {
      const messages = (await klaviyoAll(deps, `/flow-actions/${a.id}/flow-messages/`)) || [];
      for (const m of messages) {
        const t = (await deps.klaviyoGet(`/flow-messages/${m.id}/template/`)) as { data?: { attributes?: { html?: string } } } | null;
        for (const c of extractCodes(t?.data?.attributes?.html || "")) if (!seen.has(c)) seen.set(c, String(f.attributes?.name || f.id));
      }
    }
  }
  const dead: NonNullable<SiteHealthResult["promoCodes"]>["dead"] = [];
  for (const [code, flow] of seen) {
    const status = await deps.discountStatus(code);
    if (status !== "ACTIVE") dead.push({ code, status: status ?? "INTROUVABLE", flow });
  }
  return { checked: [...seen.keys()], dead };
}

async function checkSearches(deps: SiteHealthDeps): Promise<SiteHealthResult["searches"]> {
  const metrics = await klaviyoAll(deps, "/metrics/");
  const id = metrics?.find((m) => m.attributes?.name === "Submitted Search")?.id;
  if (!id) return null;
  const since = new Date(deps.now().getTime() - 7 * 86_400_000).toISOString().slice(0, 19) + "Z";
  const filter = encodeURIComponent(`and(equals(metric_id,"${id}"),greater-than(datetime,${since}))`);
  const events = (await klaviyoAll(deps, `/events/?filter=${filter}&fields[event]=event_properties&page[size]=200`, 600)) || [];
  const counts = new Map<string, { n: number; en: boolean }>();
  for (const e of events) {
    const p = (e.attributes?.event_properties || {}) as Record<string, unknown>;
    const q = String(p.SearchQuery || "").trim().toLowerCase();
    if (!q) continue;
    const c = counts.get(q) || { n: 0, en: /\/en\//.test(String(p.URL || "")) };
    c.n++; counts.set(q, c);
  }
  const queries = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_QUERIES);
  const zero: Array<{ q: string; count: number }> = [];
  await pool(queries, 2, async ([q, c]) => {
    const r = await deps.fetchPage(`${STORE_URL}${c.en ? "/en" : ""}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=3`);
    if (r.status !== 200) return;
    try {
      const n = JSON.parse(r.text)?.resources?.results?.products?.length ?? 0;
      if (n === 0) zero.push({ q, count: c.n });
    } catch { /* unparsable answer: not a verdict on the query */ }
  });
  return { tested: queries.length, zeroResults: zero.sort((a, b) => b.count - a.count) };
}

const umamiNumber = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") return (v as { value: number }).value;
  return null;
};

async function funnel(deps: SiteHealthDeps): Promise<Funnel | null> {
  const metrics = await klaviyoAll(deps, "/metrics/");
  if (!metrics) return null;
  const idOf = (name: string) => metrics.find((m) => m.attributes?.name === name && /shopify/i.test(JSON.stringify(m.attributes?.integration ?? "")))?.id
    ?? metrics.find((m) => m.attributes?.name === name)?.id;
  const end = deps.now();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const count = async (name: string) => {
    const id = idOf(name);
    if (!id) return 0;
    const r = (await deps.klaviyoPost("/metric-aggregates/", { data: { type: "metric-aggregate", attributes: {
      metric_id: id, measurements: ["count"], interval: "week", timezone: "America/Toronto",
      filter: [`greater-or-equal(datetime,${start.toISOString().slice(0, 19)})`, `less-than(datetime,${end.toISOString().slice(0, 19)})`] } } })) as
      { data?: { attributes?: { data?: Array<{ measurements?: { count?: number[] } }> } } } | null;
    return (r?.data?.attributes?.data?.[0]?.measurements?.count || []).reduce((a, b) => a + b, 0);
  };
  const [addedToCart, checkoutStarted, placedOrder] = [await count("Added to Cart"), await count("Checkout Started"), await count("Placed Order")];
  let visitors: number | null = null, addToCartClicks: number | null = null;
  const q = `startAt=${start.getTime()}&endAt=${end.getTime()}`;
  const stats = (await deps.umami(`/stats?${q}`)) as Record<string, unknown> | null;
  if (stats) visitors = umamiNumber(stats.visitors);
  const ev = (await deps.umami(`/metrics?${q}&type=event`)) as Array<{ x?: string; y?: number }> | null;
  if (Array.isArray(ev)) addToCartClicks = ev.filter((e) => e.x === "Add to Cart" || e.x === "Sticky ATC").reduce((a, e) => a + (e.y || 0), 0);
  return { days: 7, visitors, addToCartClicks, addedToCart, checkoutStarted, placedOrder };
}

const plural = (n: number, one: string, many: string) => `${n} ${n >= 2 ? many : one}`;
const short = (u: string) => u.replace(STORE_URL, "") || "/";

export function reasonsFor(r: Omit<SiteHealthResult, "reasons" | "ok" | "auditedAt">): string[] {
  const out: string[] = [];
  const p = r.pages;
  if (p.broken.length) out.push(`${plural(p.broken.length, "page ou lien cassé", "pages ou liens cassés")} : ${p.broken.slice(0, 5).map((b) => `${short(b.url)} (${b.detail})`).join(", ")}`);
  if (p.liquidErrors.length) out.push(`erreur Liquid sur ${p.liquidErrors.slice(0, 3).map((b) => short(b.url)).join(", ")}`);
  if (p.badH1.length) out.push(`${plural(p.badH1.length, "page n'a pas", "pages n'ont pas")} exactement un titre H1 : ${p.badH1.slice(0, 4).map((b) => `${short(b.url)} (${b.detail})`).join(", ")}`);
  if (p.missingMeta.length) out.push(`${plural(p.missingMeta.length, "page sans", "pages sans")} description Google : ${p.missingMeta.slice(0, 4).map(short).join(", ")}`);
  for (const d of r.promoCodes?.dead || []) out.push(`le courriel « ${d.flow} » donne le code ${d.code}, qui est ${d.status === "INTROUVABLE" ? "introuvable dans Shopify" : `${d.status} dans Shopify`} — les clients se le font refuser`);
  return out;
}

export async function runSiteHealth(deps: SiteHealthDeps): Promise<SiteHealthResult> {
  const pages = await checkPages(deps);
  const promoCodes = await checkPromoCodes(deps);
  const searches = await checkSearches(deps);
  const f = await funnel(deps);
  const base = { pages, promoCodes, searches, funnel: f };
  const reasons = reasonsFor(base);
  return { auditedAt: Math.floor(deps.now().getTime() / 1000), ok: reasons.length === 0, reasons, ...base };
}

export async function persistSiteHealth(r: SiteHealthResult): Promise<void> {
  await setSetting(SETTINGS_KEY, JSON.stringify(r));
}

export function funnelLine(f: Funnel | null): string {
  if (!f) return "";
  const parts = [
    f.visitors != null ? `${f.visitors} visiteurs` : null,
    f.addToCartClicks != null ? `${f.addToCartClicks} clics « ajouter »` : null,
    `${f.checkoutStarted} caisses commencées`,
    `${f.placedOrder} commandes`,
  ].filter(Boolean);
  const rate = f.checkoutStarted > 0 ? ` (${Math.round((100 * f.placedOrder) / f.checkoutStarted)} % des caisses)` : "";
  return `7 j : ${parts.join(" → ")}${rate}`;
}

// ─── Production wiring ───────────────────────────────────────────────

const KLAVIYO_REV = "2024-10-15";
async function klaviyoFetch(path: string, init: RequestInit = {}): Promise<unknown | null> {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://a.klaviyo.com/api${path}`, {
      ...init,
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: KLAVIYO_REV, accept: "application/vnd.api+json", "content-type": "application/vnd.api+json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("Retry-After")) || 2, 10) * 1000)); continue; }
    if (!res.ok) throw new Error(`Klaviyo ${path.split("?")[0]} -> HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`Klaviyo ${path.split("?")[0]} kept throttling`);
}

export const productionSiteHealthDeps: SiteHealthDeps = {
  async fetchPage(url) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "AmeubloSiteHealth/1.0 (+aosom-sync)" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      return { status: res.status, text: await res.text(), url: res.url };
    } catch (e) {
      return { status: 0, text: String(e), url };
    }
  },
  klaviyoGet: (path) => klaviyoFetch(path) as Promise<KlaviyoList | null>,
  klaviyoPost: (path, body) => klaviyoFetch(path, { method: "POST", body: JSON.stringify(body) }),
  async discountStatus(code) {
    const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({
      query: `query($c:String!){ codeDiscountNodeByCode(code:$c){ codeDiscount{ ... on DiscountCodeBasic{status} ... on DiscountCodeBxgy{status} ... on DiscountCodeFreeShipping{status} ... on DiscountCodeApp{status} } } }`,
      variables: { c: code } }) });
    const j = (await res.json()) as { data?: { codeDiscountNodeByCode?: { codeDiscount?: { status?: string } } | null } };
    return j.data?.codeDiscountNodeByCode?.codeDiscount?.status ?? null;
  },
  async umami(path) {
    const key = process.env.UMAMI_API_KEY, site = process.env.UMAMI_WEBSITE_ID;
    if (!key || !site) return null;
    try {
      const res = await fetch(`https://api.umami.is/v1/websites/${site}${path}`, { headers: { "x-umami-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? res.json() : null;
    } catch { return null; }
  },
  now: () => new Date(),
};
