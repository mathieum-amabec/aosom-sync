import { env, META_ADS } from "./config";

/**
 * Meta Marketing API client (Ads management) — native fetch, no SDK.
 *
 * Foundation for managing ad accounts, campaigns, ad sets, and insights from
 * Aosom-sync. The Meta Ads use cases were enabled on the Facebook app, so this
 * client uses the same user/system-user access token (META_ACCESS_TOKEN) with
 * ads_read / ads_management permissions.
 *
 * Rate limiting: Meta enforces a sliding hourly budget per ad account. We add a
 * conservative client-side cap (META_ADS.RATE_LIMIT_PER_HOUR, default 200/hour)
 * so a runaway loop or a buggy dashboard can't burn the account's real budget or
 * trip Meta's throttle. The limiter is process-local (resets on cold start) — it
 * is a guardrail, not a distributed quota.
 */

// ── client-side rate limiter (process-local sliding window) ────────────────
const HOUR_MS = 60 * 60 * 1000;
let callTimestamps: number[] = [];

/** Throws if calling now would exceed the hourly cap. Records the call otherwise. */
function consumeRateLimit(now: number): void {
  callTimestamps = callTimestamps.filter((t) => now - t < HOUR_MS);
  if (callTimestamps.length >= META_ADS.RATE_LIMIT_PER_HOUR) {
    const oldest = callTimestamps[0];
    const waitMin = Math.ceil((HOUR_MS - (now - oldest)) / 60000);
    throw new Error(
      `Meta Ads rate limit reached (${META_ADS.RATE_LIMIT_PER_HOUR}/hour). Retry in ~${waitMin} min.`,
    );
  }
  callTimestamps.push(now);
}

/** Test-only: reset the in-process rate-limit window. */
export function __resetRateLimit(): void {
  callTimestamps = [];
}

// ── low-level Graph call ───────────────────────────────────────────────────
interface GraphError {
  message: string;
  type?: string;
  code?: number;
  error_user_msg?: string;
}

async function graph<T>(
  path: string,
  opts: { method?: "GET" | "POST"; params?: Record<string, string | undefined>; body?: Record<string, unknown> } = {},
): Promise<T> {
  consumeRateLimit(Date.now());

  const url = new URL(`${META_ADS.GRAPH_API_URL}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", env.metaAccessToken);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v != null && v !== "") url.searchParams.set(k, v);
  }

  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url.toString(), init);
  const data = (await res.json().catch(() => ({}))) as { error?: GraphError } & T;

  if (data.error) {
    const e = data.error;
    throw new Error(`Meta Ads API: ${e.error_user_msg || e.message}${e.code ? ` (code ${e.code})` : ""}`);
  }
  if (!res.ok) {
    throw new Error(`Meta Ads API HTTP ${res.status} on ${path}`);
  }
  return data;
}

/** Walk Graph API cursor pagination, accumulating all pages (capped to guard runaway). */
async function graphPaged<T>(
  path: string,
  params: Record<string, string | undefined>,
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await graph<{ data: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, {
      params: { ...params, after, limit: params.limit ?? "100" },
    });
    out.push(...(page.data ?? []));
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
    pages++;
  } while (after && pages < maxPages);
  return out;
}

// ── public types ───────────────────────────────────────────────────────────
export interface AdAccount {
  id: string;            // "act_<id>"
  account_id: string;
  name: string;
  account_status: number; // 1 = active
  currency: string;
  timezone_name?: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;        // ACTIVE | PAUSED | ...
  objective?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  created_time?: string;
}

export interface AdSet {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  campaign_id?: string;
}

export interface CreateCampaignParams {
  name: string;
  /** e.g. OUTCOME_TRAFFIC, OUTCOME_SALES, OUTCOME_AWARENESS. */
  objective: string;
  /** Defaults to PAUSED — never auto-spend a freshly created campaign. */
  status?: "ACTIVE" | "PAUSED";
  /** Daily budget in the account's minor currency unit (e.g. cents). */
  dailyBudget?: number;
  /** Required by Meta since ODAX; defaults to ["NONE"] for non-special-category ads. */
  specialAdCategories?: string[];
}

export interface InsightsRow {
  spend?: string;
  reach?: string;
  impressions?: string;
  clicks?: string;
  cpc?: string;
  cpm?: string;
  ctr?: string;
  /** Return on ad spend — present only when a purchase conversion is tracked. */
  purchase_roas?: Array<{ action_type: string; value: string }>;
  date_start?: string;
  date_stop?: string;
}

export interface DateRange {
  /** YYYY-MM-DD inclusive. */
  since: string;
  /** YYYY-MM-DD inclusive. */
  until: string;
}

/** Normalize an ad account id to the "act_<id>" form Meta expects on the path. */
function actId(adAccountId: string): string {
  return adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
}

// ── public API ───────────────────────────────────────────────────────────

/** The configured default ad account (META_AD_ACCOUNT_ID), normalized to "act_<id>".
 * Undefined when not configured — callers then fall back to probing /me/adaccounts. */
export function defaultAdAccountId(): string | undefined {
  return env.metaAdAccountId ? actId(env.metaAdAccountId) : undefined;
}

/** Resolve the ad account to use for a dashboard call. Order: the configured
 * META_AD_ACCOUNT_ID (no API call), else the first ACTIVE account the token can
 * manage, else the first account. Throws when the token manages none. */
export async function resolveDefaultAdAccountId(): Promise<string> {
  const configured = defaultAdAccountId();
  if (configured) return configured;
  const accounts = await getAdAccounts();
  if (accounts.length === 0) throw new Error("No ad accounts available for this token");
  return (accounts.find((a) => a.account_status === 1) ?? accounts[0]).id;
}

/** List the ad accounts the token can manage. */
export async function getAdAccounts(): Promise<AdAccount[]> {
  return graphPaged<AdAccount>("me/adaccounts", {
    fields: "id,account_id,name,account_status,currency,timezone_name",
  });
}

/** List the ACTIVE campaigns of an ad account (effective_status = ACTIVE). */
export async function getCampaigns(adAccountId: string): Promise<Campaign[]> {
  const all = await graphPaged<Campaign>(`${actId(adAccountId)}/campaigns`, {
    fields: "id,name,status,objective,effective_status,daily_budget,lifetime_budget,created_time",
    effective_status: JSON.stringify(["ACTIVE"]),
  });
  return all;
}

/** Create a campaign. Defaults to PAUSED so it never spends until explicitly activated. */
export async function createCampaign(adAccountId: string, params: CreateCampaignParams): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    name: params.name,
    objective: params.objective,
    status: params.status ?? "PAUSED",
    special_ad_categories: params.specialAdCategories ?? ["NONE"],
  };
  if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
  return graph<{ id: string }>(`${actId(adAccountId)}/campaigns`, { method: "POST", body });
}

/** List the ad sets of a campaign. */
export async function getAdSets(campaignId: string): Promise<AdSet[]> {
  return graphPaged<AdSet>(`${campaignId}/adsets`, {
    fields: "id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,campaign_id",
  });
}

/** Account-level insights for a date range (spend, reach, clicks, ROAS, …). */
export async function getInsights(adAccountId: string, dateRange: DateRange): Promise<InsightsRow[]> {
  return graphPaged<InsightsRow>(`${actId(adAccountId)}/insights`, {
    fields: "spend,reach,impressions,clicks,cpc,cpm,ctr,purchase_roas",
    time_range: JSON.stringify({ since: dateRange.since, until: dateRange.until }),
  });
}
