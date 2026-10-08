/**
 * Bing Webmaster URL Submission. Bing knew ~50 of 3,000+ pages of the site (2026-09-30), and ChatGPT / Copilot search lean on Bing's index.
 * A plain IndexNow key file is not possible (Shopify cannot serve arbitrary files at the domain root), so the daily cron submits through the
 * Webmaster API instead: it reads the storefront sitemaps, and sends the URLs Bing has not seen (or that changed since) newest first, within
 * the daily quota Bing reports (100/day on a new site, so the backlog drains over a few weeks).
 */
import { ensureSchema } from "@/lib/database";

const API = "https://ssl.bing.com/webmaster/api.svc/json";
const BATCH = 500;
const MAX_PER_RUN = 500;

export const SITE_URL = "https://ameublodirect.ca/";

let tableReady = false;
async function db() {
  const client = await ensureSchema();
  if (!tableReady) {
    await client.execute(`CREATE TABLE IF NOT EXISTS bing_submitted (url TEXT PRIMARY KEY, submitted_at TEXT NOT NULL, lastmod TEXT)`);
    tableReady = true;
  }
  return client;
}

export function readBingKey(env: Record<string, string | undefined> = process.env): string | null {
  const k = (env.BING_WEBMASTER_API_KEY ?? "").trim();
  return k || null;
}

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** `<loc>` + optional `<lastmod>` of every `<url>` block of a urlset. */
export function parseUrlset(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(m[1]);
    if (!loc) continue;
    const lm = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/.exec(m[1]);
    out.push({ url: decode(loc[1]), lastmod: lm ? lm[1] : null });
  }
  return out;
}

/** Child sitemap URLs of a sitemap index (the "agentic discovery" one is not a urlset of pages). */
export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>[\s\S]*?<\/sitemap>/g)].map((m) => decode(m[1])).filter((u) => !u.includes("agentic_discovery"));
}

async function getText(url: string, f: typeof fetch): Promise<string> {
  const res = await f(url, { headers: { "User-Agent": "AmeubloDirect-BingSubmit/1.0" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

export async function collectSitemapUrls(f: typeof fetch = fetch, site = SITE_URL): Promise<SitemapEntry[]> {
  const index = await getText(`${site}sitemap.xml`, f);
  const all: SitemapEntry[] = [];
  for (const child of parseSitemapIndex(index)) {
    all.push(...parseUrlset(await getText(child, f)));
  }
  const seen = new Set<string>();
  return all.filter((e) => e.url.startsWith(site.replace(/\/$/, "")) && !seen.has(e.url) && seen.add(e.url));
}

/** Newest first; skips URLs already sent unless the sitemap says they changed since. */
export function pickToSubmit(entries: SitemapEntry[], sent: Map<string, { submittedAt: string; lastmod: string | null }>, limit: number): SitemapEntry[] {
  const due = entries.filter((e) => {
    const s = sent.get(e.url);
    if (!s) return true;
    return !!e.lastmod && !!s.lastmod ? e.lastmod > s.lastmod : false;
  });
  due.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
  return due.slice(0, Math.max(0, limit));
}

async function bingJson(path: string, key: string, f: typeof fetch, body?: unknown): Promise<unknown> {
  const res = await f(`${API}/${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (json as { Message?: string } | null)?.Message ?? text.slice(0, 160);
    throw new Error(`Bing ${path.split("?")[0]} → ${res.status}: ${msg}`);
  }
  return json;
}

/** URLs Bing still accepts today. */
export async function getDailyQuota(key: string, f: typeof fetch = fetch): Promise<number> {
  const j = (await bingJson(`GetUrlSubmissionQuota?siteUrl=${encodeURIComponent(SITE_URL)}`, key, f)) as { d?: { DailyQuota?: number } } | null;
  const q = Number(j?.d?.DailyQuota);
  return Number.isFinite(q) ? q : 0;
}

export interface BingResult {
  configured: boolean;
  quota?: number;
  candidates?: number;
  submitted?: number;
  remaining?: number;
}

export async function submitToBing(opts: { fetchImpl?: typeof fetch; now?: Date; env?: Record<string, string | undefined> } = {}): Promise<BingResult> {
  const key = readBingKey(opts.env);
  if (!key) return { configured: false };
  const f = opts.fetchImpl ?? fetch;
  const quota = await getDailyQuota(key, f);
  const entries = await collectSitemapUrls(f);
  const client = await db();
  const rows = (await client.execute(`SELECT url, submitted_at, lastmod FROM bing_submitted`)).rows;
  const sent = new Map(rows.map((r) => [String(r.url), { submittedAt: String(r.submitted_at), lastmod: (r.lastmod as string | null) ?? null }]));
  const limit = Math.min(quota, MAX_PER_RUN);
  const due = pickToSubmit(entries, sent, limit);
  const stamp = (opts.now ?? new Date()).toISOString();
  let submitted = 0;
  for (let i = 0; i < due.length; i += BATCH) {
    const chunk = due.slice(i, i + BATCH);
    await bingJson("SubmitUrlbatch", key, f, { siteUrl: SITE_URL.replace(/\/$/, ""), urlList: chunk.map((c) => c.url) });
    await client.batch(
      chunk.map((c) => ({ sql: `INSERT OR REPLACE INTO bing_submitted (url, submitted_at, lastmod) VALUES (?, ?, ?)`, args: [c.url, stamp, c.lastmod] })),
      "write",
    );
    submitted += chunk.length;
  }
  const remaining = pickToSubmit(entries, new Map([...sent, ...due.map((d) => [d.url, { submittedAt: stamp, lastmod: d.lastmod }] as const)]), Infinity).length;
  return { configured: true, quota, candidates: entries.length, submitted, remaining };
}
