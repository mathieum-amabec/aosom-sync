/**
 * First visit vs return — our own count, because Shopify analytics cannot split non-buyers into new and returning
 * (Mat, 2026-11-16: "combien viennent et reviennent, et achètent ou n'achètent pas").
 *
 * The storefront pixel script (src/app/api/pixel/script/route.ts) keeps a random id in localStorage (`lc_vid`, the
 * same key the "bientôt" teasers use) and a visit counter (`lc_vis`). A new visit starts after 30 min without a page
 * view, like Shopify's sessions. It sends one beacon per visit, plus one when that visit adds to the cart and one when
 * it heads to checkout; the visit number also rides on the cart as the hidden attribute `_lc_v`, so orders carry it.
 * No PII: the id is random, stored hashed, no IP is kept. Bots, the theme editor and visitors who refused analytics
 * are skipped by the script. Kill switch: setting `visit_tracking` = "0" (the endpoint then stores nothing).
 */
import crypto from "crypto";

export const VISIT_EVENTS = ["visit", "atc", "checkout"] as const;
export type VisitEvent = (typeof VISIT_EVENTS)[number];

export function isVisitEvent(v: unknown): v is VisitEvent {
  return typeof v === "string" && (VISIT_EVENTS as readonly string[]).includes(v);
}

export function isVisitorId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

export function hashVisitorId(id: string): string {
  return crypto.createHash("sha256").update(`visit:${id}`).digest("hex").slice(0, 32);
}

export function isVisitNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100_000;
}

const BOT_UA = /bot|crawl|spider|slurp|lighthouse|headless|preview|facebookexternalhit|pinterestbot|embedly|bingpreview/i;

export function isBotUserAgent(ua: string | null): boolean {
  return !ua || BOT_UA.test(ua);
}

export function deviceOf(ua: string | null): "mobile" | "tablet" | "desktop" {
  const s = ua || "";
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(s)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(s)) return "mobile";
  return "desktop";
}

/** Landing page without its query string, plus the utm_source and whether it came from a Meta ad click. */
export function parseLanding(url: string): { host: string; path: string; utm: string | null; fbclid: boolean } | null {
  try {
    const u = new URL(url);
    const utm = u.searchParams.get("utm_source");
    return {
      host: u.host.replace(/^www\./, ""),
      path: u.pathname.slice(0, 200),
      utm: utm ? utm.slice(0, 60).toLowerCase() : null,
      fbclid: u.searchParams.has("fbclid"),
    };
  } catch {
    return null;
  }
}

/** Referrer host only (never the full URL, which can carry search terms or ids). Own domains count as none. */
export function referrerHost(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref) return null;
  try {
    const h = new URL(ref).host.replace(/^www\./, "").slice(0, 100);
    return /(^|\.)(ameublodirect|furnishdirect)\.ca$|myshopify\.com$/.test(h) ? null : h;
  } catch {
    return null;
  }
}

/** Visit-number buckets for the report: 1st visit, 2nd, 3rd–5th, 6th and later. */
export function visitBucket(n: number): "1" | "2" | "3-5" | "6+" {
  return n <= 1 ? "1" : n === 2 ? "2" : n <= 5 ? "3-5" : "6+";
}

interface Tally { visits: number; atc: number; checkout: number }
const tally = (): Tally => ({ visits: 0, atc: 0, checkout: 0 });
const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export interface VisitorReportRow {
  visitor_hash: string; visit_n: number; pre: number; host: string | null; atc: number; checkout: number; gap_days: number | null;
}

/**
 * Aggregate raw visits. "Came back" = a visitor with a visit numbered 2 or more in the window, or whose first visit
 * in the window is not their first ever. Visitors whose id predates counting (pre = 1) are left out of the new/return
 * split for their visit 1, which may not be their first.
 */
export function buildVisitorReport(rows: VisitorReportRow[]) {
  const perSite: Record<string, { visitors: Set<string>; returning: Set<string>; byVisit: Record<string, Tally>; all: Tally }> = {};
  const gaps: number[] = [];
  for (const r of rows) {
    const site = r.host || "(inconnu)";
    const s = (perSite[site] ??= { visitors: new Set(), returning: new Set(), byVisit: {}, all: tally() });
    s.visitors.add(r.visitor_hash);
    if (r.visit_n >= 2 || r.pre) s.returning.add(r.visitor_hash);
    const b = r.pre && r.visit_n === 1 ? "inconnu" : visitBucket(r.visit_n);
    const t = (s.byVisit[b] ??= tally());
    for (const x of [t, s.all]) { x.visits++; x.atc += r.atc ? 1 : 0; x.checkout += r.checkout ? 1 : 0; }
    if (r.visit_n >= 2 && r.gap_days != null) gaps.push(r.gap_days);
  }
  gaps.sort((a, b) => a - b);
  const sites = Object.entries(perSite).map(([site, s]) => ({
    site,
    visits: s.all.visits,
    visitors: s.visitors.size,
    returningVisitors: s.returning.size,
    returningPct: rate(s.returning.size, s.visitors.size),
    atcPct: rate(s.all.atc, s.all.visits),
    checkoutPct: rate(s.all.checkout, s.all.visits),
    byVisit: Object.fromEntries(Object.entries(s.byVisit).map(([k, t]) => [k, { ...t, atcPct: rate(t.atc, t.visits), checkoutPct: rate(t.checkout, t.visits) }])),
  })).sort((a, b) => b.visits - a.visits);
  return { sites, medianDaysBetweenVisits: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null };
}
