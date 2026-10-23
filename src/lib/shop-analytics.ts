/**
 * Shopify store numbers for the morning report: sales, visits, funnel, traffic sources and where
 * the orders came from. READ-ONLY (needs the read_reports + read_orders scopes granted 2026-10-22).
 *
 * Visits/funnel/sales come from ShopifyQL (`shopifyqlQuery`); the origin of each order comes from
 * the order's customer journey (last visit, falling back to the first). The pure helpers
 * (classifyOrderSource, summarize*, montrealDayRangeUtc) are unit-tested without the network.
 */
import { shopifyFetch } from "./shopify-client";
import { getInsights } from "./meta-ads-client";
import { REPORT_TIME_ZONE } from "./morning-report";

// ── types ─────────────────────────────────────────────────────────────────────
export interface FunnelStats {
  sessions: number;
  carts: number;
  checkouts: number;
  bought: number;
  /** bought / sessions, 0..1 */
  conversion: number;
}

export interface SalesStats {
  orders: number;
  /** Total sales incl. taxes, after returns. */
  total: number;
  /** Average order value; null when there are no orders. */
  aov: number | null;
}

export interface SourceStat {
  name: string;
  sessions: number;
  bought: number;
  conversion: number;
}

export interface OrderSourceStat {
  label: string;
  orders: number;
  total: number;
}

export interface ShopSummary {
  /** The day the "yesterday" figures cover (YYYY-MM-DD, Montreal). */
  day: string;
  /** First day of the 7-day window ending on `day`. */
  weekStart: string;
  dayFunnel: FunnelStats;
  daySales: SalesStats;
  weekFunnel: FunnelStats;
  weekSales: SalesStats;
  prevWeekFunnel: FunnelStats;
  prevWeekSales: SalesStats;
  /** Traffic sources of the 7-day window, biggest first. */
  sources: SourceStat[];
  /** Yesterday's orders grouped by where the buyer came from. */
  dayOrderSources: OrderSourceStat[];
  /** Meta ads over the 7 days vs the orders Shopify itself attributes to a Meta ad. */
  meta: { spend: number; orders: number; costPerOrder: number | null } | { error: string };
}

// ── pure helpers ──────────────────────────────────────────────────────────────
export const META_AD_LABEL = "Meta (pub)";

export interface JourneyVisit {
  source?: string | null;
  sourceType?: string | null;
  referrerUrl?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
}

/** Where an order came from, from its last visit (or the first one when the last carries nothing). */
export function classifyOrderSource(journey: { lastVisit?: JourneyVisit | null; firstVisit?: JourneyVisit | null } | null | undefined): string {
  const visits = [journey?.lastVisit, journey?.firstVisit].filter((v): v is JourneyVisit => !!v);
  for (const v of visits) {
    const utm = v.utmParameters ?? {};
    const text = `${v.source ?? ""} ${utm.source ?? ""} ${v.referrerUrl ?? ""}`.toLowerCase();
    const campaign = (utm.campaign ?? "").toLowerCase();
    const medium = (utm.medium ?? "").toLowerCase();
    const meta = /facebook|instagram|(^|[^a-z])fb([^a-z]|$)|meta/.test(text);
    // Meta ads: a numeric campaign id or one of our campaign tags, or any paid tag on a Meta source.
    if (meta && (/^\d{10,}$/.test(campaign) || /advantage|liquidation|retargeting|halloween|collection|prix_bas|meta_catalog/.test(campaign) || medium === "paid" || medium === "cpc")) {
      return META_AD_LABEL;
    }
    if (/chatgpt|openai|perplexity|claude\.ai|gemini/.test(text)) return "ChatGPT / IA";
    if (/klaviyo|resend/.test(text) || medium === "email" || /(^|[^a-z])mail\./.test(text) || /gmail|outlook|hotmail|android-app:\/\/com\.google\.android\.gm/.test(text)) return "Courriel";
    if (/google|bing|duckduckgo|yahoo|ecosia/.test(text) || (v.sourceType ?? "").toLowerCase() === "seo") return "Recherche (Google, Bing…)";
    if (meta) return "Facebook / Instagram (sans pub identifiée)";
    if (text.trim() && !/direct/.test(text)) return "Autre";
  }
  return "Direct";
}

export function groupOrderSources(orders: Array<{ journey: Parameters<typeof classifyOrderSource>[0]; total: number }>): OrderSourceStat[] {
  const by = new Map<string, OrderSourceStat>();
  for (const o of orders) {
    const label = classifyOrderSource(o.journey);
    const s = by.get(label) ?? { label, orders: 0, total: 0 };
    s.orders += 1;
    s.total += o.total;
    by.set(label, s);
  }
  return [...by.values()].sort((a, b) => b.orders - a.orders || b.total - a.total);
}

/** UTC bounds [start, end) of one Montreal calendar day (handles the EDT/EST switch). */
export function montrealDayRangeUtc(date: string): { startIso: string; endIso: string } {
  const startOf = (d: string) => {
    for (const hour of [4, 5]) {
      const probe = new Date(`${d}T${String(hour).padStart(2, "0")}:00:00Z`);
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(probe);
      const p = Object.fromEntries(local.map((x) => [x.type, x.value]));
      if (`${p.year}-${p.month}-${p.day}` === d && p.hour === "00") return probe;
    }
    return new Date(`${d}T04:00:00Z`);
  };
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { startIso: startOf(date).toISOString(), endIso: startOf(next.toISOString().slice(0, 10)).toISOString() };
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── ShopifyQL ─────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

async function shopifyql(query: string): Promise<Row[]> {
  const res = await shopifyFetch("/graphql.json", {
    method: "POST",
    body: JSON.stringify({
      query: `query($q:String!){shopifyqlQuery(query:$q){tableData{columns{name} rows} parseErrors}}`,
      variables: { q: query },
    }),
  });
  if (!res.ok) throw new Error(`ShopifyQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`ShopifyQL: ${JSON.stringify(json.errors).slice(0, 200)}`);
  const q = json.data?.shopifyqlQuery;
  if (q?.parseErrors?.length) throw new Error(`ShopifyQL parse: ${JSON.stringify(q.parseErrors).slice(0, 200)}`);
  const cols: string[] = (q?.tableData?.columns ?? []).map((c: { name: string }) => c.name);
  return (q?.tableData?.rows ?? []).map((r: unknown) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : (r as Row),
  );
}

export function funnelFrom(row: Row | undefined): FunnelStats {
  const sessions = num(row?.sessions);
  const bought = num(row?.sessions_that_completed_checkout);
  return {
    sessions,
    carts: num(row?.sessions_with_cart_additions),
    checkouts: num(row?.sessions_that_reached_checkout),
    bought,
    conversion: sessions > 0 ? bought / sessions : 0,
  };
}

export function salesFrom(row: Row | undefined): SalesStats {
  const orders = num(row?.orders);
  const total = num(row?.total_sales);
  return { orders, total, aov: orders > 0 ? total / orders : null };
}

const FUNNEL_COLS = "sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout";
const range = (since: string, until: string) => `SINCE ${since} UNTIL ${until}`;

async function funnel(since: string, until: string): Promise<FunnelStats> {
  return funnelFrom((await shopifyql(`FROM sessions SHOW ${FUNNEL_COLS} ${range(since, until)}`))[0]);
}
async function sales(since: string, until: string): Promise<SalesStats> {
  return salesFrom((await shopifyql(`FROM sales SHOW orders, total_sales ${range(since, until)}`))[0]);
}

const SOURCE_LABEL: Record<string, string> = {
  social: "réseaux sociaux",
  direct: "direct",
  search: "recherche",
  email: "courriel",
  unknown: "inconnu",
};

async function trafficSources(since: string, until: string): Promise<SourceStat[]> {
  const rows = await shopifyql(
    `FROM sessions SHOW sessions, sessions_that_completed_checkout GROUP BY referrer_source ${range(since, until)} ORDER BY sessions DESC LIMIT 8`,
  );
  return rows
    .filter((r) => r.referrer_source != null && num(r.sessions) > 0)
    .map((r) => {
      const sessions = num(r.sessions);
      const bought = num(r.sessions_that_completed_checkout);
      const key = String(r.referrer_source);
      return { name: SOURCE_LABEL[key] ?? key, sessions, bought, conversion: sessions > 0 ? bought / sessions : 0 };
    });
}

// ── orders ────────────────────────────────────────────────────────────────────
/** "2026-10-22T04:00:00.000Z" → "2026-10-22T04:00:00Z" (see the note in ordersBetween). */
export const noMillis = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");

async function ordersBetween(startIso: string, endIso: string): Promise<Array<{ journey: Parameters<typeof classifyOrderSource>[0]; total: number }>> {
  const out: Array<{ journey: Parameters<typeof classifyOrderSource>[0]; total: number }> = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const res = await shopifyFetch("/graphql.json", {
      method: "POST",
      body: JSON.stringify({
        query: `query($q:String!,$after:String){orders(first:100,after:$after,query:$q){pageInfo{hasNextPage endCursor} nodes{
          createdAt totalPriceSet{shopMoney{amount}} cancelledAt
          customerJourneySummary{
            firstVisit{source sourceType referrerUrl utmParameters{source medium campaign}}
            lastVisit{source sourceType referrerUrl utmParameters{source medium campaign}}}}}}`,
        // The `<` bound is not honoured by Shopify's order search in practice (verified live: orders after the end came back), so the window is also enforced below.
        variables: { q: `created_at:>=${noMillis(startIso)} created_at:<${noMillis(endIso)}`, after },
      }),
    });
    if (!res.ok) throw new Error(`orders HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`orders: ${JSON.stringify(json.errors).slice(0, 200)}`);
    const conn = json.data?.orders;
    for (const n of conn?.nodes ?? []) {
      if (n.cancelledAt) continue;
      const at = Date.parse(n.createdAt);
      if (!(at >= Date.parse(startIso) && at < Date.parse(endIso))) continue;
      out.push({ journey: n.customerJourneySummary ?? null, total: num(n.totalPriceSet?.shopMoney?.amount) });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// ── collect ───────────────────────────────────────────────────────────────────
/** All the store numbers for the report. `day` = the Montreal day to report (yesterday). */
export async function collectShopSummary(day: string, metaAccountId: string | null): Promise<ShopSummary> {
  const weekStart = addDays(day, -6);
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekStart, -1);
  const [dayFunnel, daySales, weekFunnel, weekSales, prevWeekFunnel, prevWeekSales, sources] = await Promise.all([
    funnel(day, day),
    sales(day, day),
    funnel(weekStart, day),
    sales(weekStart, day),
    funnel(prevStart, prevEnd),
    sales(prevStart, prevEnd),
    trafficSources(weekStart, day),
  ]);

  const dayRange = montrealDayRangeUtc(day);
  const dayOrders = await ordersBetween(dayRange.startIso, dayRange.endIso);
  const dayOrderSources = groupOrderSources(dayOrders);

  let meta: ShopSummary["meta"];
  try {
    if (!metaAccountId) throw new Error("compte Meta indisponible");
    const weekOrders = await ordersBetween(montrealDayRangeUtc(weekStart).startIso, dayRange.endIso);
    const metaOrders = groupOrderSources(weekOrders).find((o) => o.label === META_AD_LABEL)?.orders ?? 0;
    const spend = num((await getInsights(metaAccountId, { since: weekStart, until: day }))[0]?.spend);
    meta = { spend, orders: metaOrders, costPerOrder: metaOrders > 0 ? spend / metaOrders : null };
  } catch (err) {
    meta = { error: err instanceof Error ? err.message : String(err) };
  }

  return { day, weekStart, dayFunnel, daySales, weekFunnel, weekSales, prevWeekFunnel, prevWeekSales, sources, dayOrderSources, meta };
}
