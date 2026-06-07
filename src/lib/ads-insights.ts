// Pure helpers for the Meta Ads dashboard panel — no I/O, fully unit-testable.
// The route handler does the auth/token/cache/network work and delegates the
// number-crunching here so it can be tested without hitting the Graph API.
import type { InsightsRow, DateRange, AdAccount } from "./meta-ads-client";

/**
 * Choose which ad account to report on. Prefers a configured `preferredId`
 * (`META_AD_ACCOUNT_ID`, with or without the `act_` prefix) when it's present in
 * the token's accessible accounts; otherwise falls back to the first ACTIVE
 * account, then the first account. Returns null when there are no accounts.
 */
export function pickAdAccount(accounts: AdAccount[], preferredId?: string | null): AdAccount | null {
  if (accounts.length === 0) return null;
  const pref = preferredId?.trim();
  if (pref) {
    const bare = pref.replace(/^act_/, "");
    const match = accounts.find((a) => a.id === pref || a.id === `act_${bare}` || a.account_id === bare);
    if (match) return match;
  }
  return accounts.find((a) => a.account_status === 1) ?? accounts[0];
}

/** Aggregated, dashboard-ready ad metrics over a date range. */
export interface AdsMetrics {
  spend: number;        // total spend in the account currency (CAD)
  reach: number;        // people reached
  impressions: number;  // ad impressions
  clicks: number;       // link/all clicks
  roas: number;         // return on ad spend = revenue / spend (0 when no spend/conversions)
  cpm: number;          // cost per 1000 impressions = spend / impressions * 1000
  ctr: number;          // click-through rate, percent = clicks / impressions * 100
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (s: string | undefined): number => {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
};

// Meta's purchase_roas array often carries OVERLAPPING action types — e.g.
// `omni_purchase` is a superset of `offsite_conversion.fb_pixel_purchase` and
// `purchase`. Summing them would count the same revenue 2–3× and inflate ROAS.
// Pick a single canonical entry instead (preferring the consolidated omni value),
// falling back to the max so we never overstate the headline number.
const ROAS_PRIORITY = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

/** The row's ROAS ratio (revenue/spend) from a single canonical purchase action
 * type. 0 when nothing converted. Never sums overlapping action types. */
function rowRoas(row: InsightsRow): number {
  const entries = row.purchase_roas;
  if (!entries || entries.length === 0) return 0;
  for (const type of ROAS_PRIORITY) {
    const hit = entries.find((e) => e.action_type === type);
    if (hit) return num(hit.value);
  }
  return Math.max(...entries.map((e) => num(e.value)));
}

/** Aggregate account insight rows into the six headline metrics. Account-level
 * insights for a single time_range normally return ONE row; we still fold over all
 * rows so the math is correct if Meta ever splits the result.
 *
 * Additive fields (spend, impressions, clicks) are summed. `reach` is a
 * de-duplicated unique-people count and is NOT additive across rows, so we take
 * the max (correct for the one-row case; a safe lower-bound if rows ever split).
 *
 * Derived metrics are computed from the *totals*, not averaged per row:
 *  - ROAS  = total revenue / total spend, where revenue per row = rowRoas * spend
 *  - CPM   = total spend / total impressions * 1000
 *  - CTR   = total clicks / total impressions * 100
 * Guards divide-by-zero (no impressions / no spend → 0). */
export function aggregateInsights(rows: InsightsRow[]): AdsMetrics {
  let spend = 0, reach = 0, impressions = 0, clicks = 0, revenue = 0;
  for (const row of rows) {
    const s = num(row.spend);
    spend += s;
    reach = Math.max(reach, num(row.reach)); // reach is not additive — see above
    impressions += num(row.impressions);
    clicks += num(row.clicks);
    revenue += rowRoas(row) * s; // revenue contribution of this row
  }
  return {
    spend: round2(spend),
    reach: Math.round(reach),
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    roas: spend > 0 ? round2(revenue / spend) : 0,
    cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
    ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
  };
}

const MAX_DAYS = 365;

/** Build a Meta time_range (YYYY-MM-DD, inclusive both ends, UTC) covering the
 * last `days` days ending today. `days` is clamped to [1, 365]. */
export function rangeForDays(days: number, now: Date): DateRange {
  const span = Math.min(MAX_DAYS, Math.max(1, Math.floor(days) || 1));
  const ymd = (d: Date): string => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const until = ymd(now);
  const since = ymd(new Date(now.getTime() - (span - 1) * 86_400_000));
  return { since, until };
}

/** Parse + clamp a `?days=` query value, defaulting to 30. */
export function parseDays(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(MAX_DAYS, n);
}
