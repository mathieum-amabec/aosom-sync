/**
 * Google Search Console → Turso. Two small daily tables (per page, per query) refreshed by the daily cron, plus the
 * summary the /seo page reads. Search Console data lags about two days and is revised, so each run re-imports the last
 * `days` days (delete + insert for the range: idempotent).
 */
import { ensureSchema } from "@/lib/database";
import { queryAll, readGscConfig, type GscConfig, type SearchRow } from "@/lib/gsc-client";

let tablesReady = false;
async function db() {
  const client = await ensureSchema();
  if (!tablesReady) {
    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS gsc_page_daily (day TEXT NOT NULL, page TEXT NOT NULL, clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, position REAL NOT NULL, PRIMARY KEY (day, page))`,
        `CREATE INDEX IF NOT EXISTS idx_gsc_page_daily_day ON gsc_page_daily(day)`,
        `CREATE TABLE IF NOT EXISTS gsc_query_daily (day TEXT NOT NULL, query TEXT NOT NULL, clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, position REAL NOT NULL, PRIMARY KEY (day, query))`,
        `CREATE INDEX IF NOT EXISTS idx_gsc_query_daily_day ON gsc_query_daily(day)`,
      ],
      "write",
    );
    tablesReady = true;
  }
  return client;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** The newest day Search Console has final data for (today minus 2). */
export function latestFinalDay(now = new Date()): string {
  return iso(addDays(now, -2));
}

export interface SyncResult {
  configured: boolean;
  missing?: string[];
  startDate?: string;
  endDate?: string;
  pageRows?: number;
  queryRows?: number;
}

const CHUNK = 250;

async function insertRows(table: "gsc_page_daily" | "gsc_query_daily", col: "page" | "query", rows: SearchRow[]): Promise<void> {
  const client = await db();
  for (let i = 0; i < rows.length; i += CHUNK) {
    await client.batch(
      rows.slice(i, i + CHUNK).map((r) => ({
        sql: `INSERT OR REPLACE INTO ${table} (day, ${col}, clicks, impressions, position) VALUES (?, ?, ?, ?, ?)`,
        args: [r.keys[0], r.keys[1], Math.round(r.clicks), Math.round(r.impressions), r.position],
      })),
      "write",
    );
  }
}

export async function syncGsc(opts: { days?: number; now?: Date; config?: GscConfig; fetchImpl?: typeof fetch } = {}): Promise<SyncResult> {
  let config = opts.config;
  if (!config) {
    const c = readGscConfig();
    if (!c.configured) return { configured: false, missing: c.missing };
    config = c.config;
  }
  const days = Math.max(1, Math.min(opts.days ?? 7, 480));
  const endDate = latestFinalDay(opts.now);
  const startDate = iso(addDays(new Date(endDate + "T00:00:00Z"), -(days - 1)));

  const pages = await queryAll(config, { startDate, endDate, dimensions: ["date", "page"] }, 100_000, opts.fetchImpl);
  const queries = await queryAll(config, { startDate, endDate, dimensions: ["date", "query"] }, 100_000, opts.fetchImpl);

  const client = await db();
  await client.batch(
    [
      { sql: `DELETE FROM gsc_page_daily WHERE day >= ? AND day <= ?`, args: [startDate, endDate] },
      { sql: `DELETE FROM gsc_query_daily WHERE day >= ? AND day <= ?`, args: [startDate, endDate] },
    ],
    "write",
  );
  await insertRows("gsc_page_daily", "page", pages);
  await insertRows("gsc_query_daily", "query", queries);
  return { configured: true, startDate, endDate, pageRows: pages.length, queryRows: queries.length };
}

// ── summary ──────────────────────────────────────────────────────────────────────────────────

export type Section = "Guides d'achat" | "Blogue" | "Produits" | "Collections" | "Accueil" | "Autre";

export function classifyPage(url: string): Section {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* already a path */
  }
  path = path.replace(/^\/(?:en|fr)(?=\/|$)/, "") || "/";
  if (/^\/blogs\/guides(?:\/|$)/.test(path)) return "Guides d'achat";
  if (/^\/blogs\//.test(path)) return "Blogue";
  if (/^\/products\//.test(path)) return "Produits";
  if (/^\/collections(?:\/|$)/.test(path)) return "Collections";
  if (path === "/") return "Accueil";
  return "Autre";
}

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Metric {
  clicks: number;
  impressions: number;
  /** impression-weighted average position */
  position: number;
}

export function totalsOf(rows: Metric[]): Totals {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const weighted = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? weighted / impressions : 0 };
}

export interface SeoSummary {
  connected: boolean;
  lastDay: string | null;
  days: number;
  current: Totals;
  previous: Totals;
  sections: Array<{ section: Section; pages: number } & Totals>;
  topPages: Array<{ page: string; section: Section } & Totals>;
  topQueries: Array<{ query: string } & Totals>;
  /** Blog/guide pages with impressions but no clicks: titles/descriptions worth improving. */
  contentOpportunities: Array<{ page: string; impressions: number; position: number }>;
}

interface AggRow {
  key: string;
  clicks: number;
  impressions: number;
  position: number;
}

async function aggregate(table: "gsc_page_daily" | "gsc_query_daily", col: "page" | "query", from: string, to: string): Promise<AggRow[]> {
  const client = await db();
  const r = await client.execute({
    sql: `SELECT ${col} AS key, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) * 1.0 / SUM(impressions) ELSE 0 END AS position
          FROM ${table} WHERE day >= ? AND day <= ? GROUP BY ${col}`,
    args: [from, to],
  });
  return r.rows.map((x) => ({ key: String(x.key), clicks: Number(x.clicks) || 0, impressions: Number(x.impressions) || 0, position: Number(x.position) || 0 }));
}

export async function getSeoSummary(days = 28, now = new Date()): Promise<SeoSummary> {
  const client = await db();
  const last = (await client.execute(`SELECT MAX(day) AS d FROM gsc_page_daily`)).rows[0]?.d as string | null | undefined;
  const empty: Totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  if (!last) return { connected: readGscConfig().configured, lastDay: null, days, current: empty, previous: empty, sections: [], topPages: [], topQueries: [], contentOpportunities: [] };

  const end = new Date(last + "T00:00:00Z");
  const curFrom = iso(addDays(end, -(days - 1)));
  const prevTo = iso(addDays(end, -days));
  const prevFrom = iso(addDays(end, -(2 * days - 1)));
  void now;

  const [curPages, prevPages, curQueries] = await Promise.all([
    aggregate("gsc_page_daily", "page", curFrom, last),
    aggregate("gsc_page_daily", "page", prevFrom, prevTo),
    aggregate("gsc_query_daily", "query", curFrom, last),
  ]);
  const bySection = new Map<Section, AggRow[]>();
  for (const p of curPages) {
    const s = classifyPage(p.key);
    (bySection.get(s) ?? bySection.set(s, []).get(s)!).push(p);
  }
  const sections = [...bySection.entries()]
    .map(([section, rows]) => ({ section, pages: rows.length, ...totalsOf(rows) }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const rank = (a: AggRow, b: AggRow) => b.clicks - a.clicks || b.impressions - a.impressions;
  return {
    connected: true,
    lastDay: last,
    days,
    current: totalsOf(curPages),
    previous: totalsOf(prevPages),
    sections,
    topPages: [...curPages].sort(rank).slice(0, 10).map((p) => ({ page: p.key, section: classifyPage(p.key), ...totalsOf([p]) })),
    topQueries: [...curQueries].sort(rank).slice(0, 10).map((q) => ({ query: q.key, ...totalsOf([q]) })),
    contentOpportunities: curPages
      .filter((p) => ["Blogue", "Guides d'achat"].includes(classifyPage(p.key)) && p.clicks === 0 && p.impressions >= 20)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 8)
      .map((p) => ({ page: p.key, impressions: p.impressions, position: p.position })),
  };
}
