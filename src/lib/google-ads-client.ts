/**
 * Google Ads API client — raw REST (no `google-ads-api` / `google-ads-node` dependency),
 * mirroring the Meta-ads scripts' plain-`fetch` posture and keeping the dependency tree flat.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────────────────
 * OAuth2 refresh-token flow against https://oauth2.googleapis.com/token, plus the
 * `developer-token` header that Google Ads (unlike every other Google API) also requires.
 *
 * ⚠ The Google Ads scope is `https://www.googleapis.com/auth/adwords` — NOT the Merchant
 * Center scope (`https://www.googleapis.com/auth/content`). A refresh token is minted
 * against a fixed scope set, so a Merchant-Center refresh token CANNOT be reused here: it
 * will refresh fine and then fail every Ads call with PERMISSION_DENIED / insufficient
 * scope. Either mint a dedicated Ads refresh token, or mint one token consented to both
 * scopes at once. See docs/GOOGLE-ADS-SETUP.md.
 *
 * ── Dry-run ─────────────────────────────────────────────────────────────────────────────
 * Constructed with `dryRun: true`, the client sends NOTHING: every mutate is recorded in
 * `client.plan` and answered with a synthetic resource name, so a caller builds the whole
 * object chain through one code path whether or not credentials exist. This is what lets
 * scripts/create-google-shopping-campaign.mts render a complete campaign with an empty
 * .env.local.
 */

// Google sunsets an API version roughly every 4 months. Verify against
// https://developers.google.com/google-ads/api/docs/release-notes before a live run.
export const GOOGLE_ADS_API_VERSION = "v21";

/** The ONLY scope Google Ads accepts. Distinct from Merchant Center's `.../auth/content`. */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://googleads.googleapis.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export const MICROS = 1_000_000;
/** CAD (or any currency unit) → micros, the only money unit the Ads API accepts. */
export const toMicros = (amount: number): string => String(Math.round(amount * MICROS));

// ─── Credentials ──────────────────────────────────────────────────────────────────────

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Digits only — the API rejects the dashed `123-456-7890` display form. */
  customerId: string;
  /** Manager (MCC) id, digits only. Omit when the account sits under no MCC. */
  loginCustomerId?: string;
}

/** Names of the env vars this client reads, in the order the setup doc provisions them. */
export const GOOGLE_ADS_ENV_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const;

/** Strip the display formatting Google Ads shows in its UI (`123-456-7890`). */
export const normalizeCustomerId = (id: string): string => id.replace(/\D/g, "");

/**
 * Read credentials from the environment. Falls back to the generic `GOOGLE_CLIENT_ID` /
 * `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` names when the Ads-specific ones are
 * absent, so a single Google OAuth app can serve several integrations — but only if that
 * refresh token was consented to GOOGLE_ADS_SCOPE (see the auth note above).
 *
 * Returns `null` when anything required is missing, so callers can degrade to dry-run
 * instead of throwing.
 */
export function readGoogleAdsCredentials(
  source: Record<string, string | undefined> = process.env,
): GoogleAdsCredentials | null {
  const developerToken = source.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId = source.GOOGLE_ADS_CLIENT_ID ?? source.GOOGLE_CLIENT_ID;
  const clientSecret = source.GOOGLE_ADS_CLIENT_SECRET ?? source.GOOGLE_CLIENT_SECRET;
  const refreshToken = source.GOOGLE_ADS_REFRESH_TOKEN ?? source.GOOGLE_REFRESH_TOKEN;
  const customerId = source.GOOGLE_ADS_CUSTOMER_ID;
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) return null;
  const loginCustomerId = source.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  return {
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    customerId: normalizeCustomerId(customerId),
    ...(loginCustomerId ? { loginCustomerId: normalizeCustomerId(loginCustomerId) } : {}),
  };
}

/** Which of the required env vars are missing — for actionable "run setup" errors. */
export function missingGoogleAdsEnv(
  source: Record<string, string | undefined> = process.env,
): string[] {
  const aliases: Record<string, string[]> = {
    GOOGLE_ADS_CLIENT_ID: ["GOOGLE_CLIENT_ID"],
    GOOGLE_ADS_CLIENT_SECRET: ["GOOGLE_CLIENT_SECRET"],
    GOOGLE_ADS_REFRESH_TOKEN: ["GOOGLE_REFRESH_TOKEN"],
  };
  return GOOGLE_ADS_ENV_KEYS.filter(
    (key) => !source[key] && !(aliases[key] ?? []).some((alt) => source[alt]),
  );
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────

interface GoogleAdsErrorDetail {
  message?: string;
  errorCode?: Record<string, string>;
  trigger?: { stringValue?: string };
  location?: { fieldPathElements?: { fieldName?: string }[] };
}

/** Flattens Google's deeply nested error envelope into something readable in a terminal. */
export class GoogleAdsApiError extends Error {
  readonly status: number;
  readonly details: GoogleAdsErrorDetail[];
  constructor(path: string, status: number, body: unknown) {
    const details = extractErrorDetails(body);
    const lines = details.map((d) => {
      const code = d.errorCode ? Object.values(d.errorCode)[0] : "UNKNOWN";
      const field = d.location?.fieldPathElements?.map((f) => f.fieldName).filter(Boolean).join(".");
      return `  • ${code}: ${d.message ?? ""}${field ? ` (at ${field})` : ""}`;
    });
    super(
      `Google Ads ${path} failed (HTTP ${status})` + (lines.length ? `\n${lines.join("\n")}` : ""),
    );
    this.name = "GoogleAdsApiError";
    this.status = status;
    this.details = details;
  }
}

function extractErrorDetails(body: unknown): GoogleAdsErrorDetail[] {
  if (!body || typeof body !== "object") return [];
  const err = (body as { error?: { details?: unknown[] } }).error;
  if (!err?.details) return [];
  const out: GoogleAdsErrorDetail[] = [];
  for (const d of err.details) {
    const errors = (d as { errors?: GoogleAdsErrorDetail[] }).errors;
    if (Array.isArray(errors)) out.push(...errors);
  }
  return out;
}

// ─── Mutate/response shapes ───────────────────────────────────────────────────────────

export interface MutateResult {
  results?: { resourceName: string }[];
}

/** One recorded mutate, for dry-run rendering and post-run auditing. */
export interface PlannedMutate {
  step: string;
  path: string;
  operations: unknown[];
  /** Resource names returned (real) or synthesized (dry-run). */
  resourceNames: string[];
}

export type CampaignStatus = "ENABLED" | "PAUSED" | "REMOVED";
export type KeywordMatchType = "EXACT" | "PHRASE" | "BROAD";
export type DayOfWeek =
  | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";

/**
 * Bidding strategy. Only MANUAL_CPC honours bid modifiers (ad schedule, device, audience)
 * and the ad group's `cpcBidMicros`; the two automated strategies ignore both — Google
 * sets every bid itself.
 */
export type BiddingStrategy =
  | { kind: "MAXIMIZE_CONVERSION_VALUE"; targetRoas?: number }
  | { kind: "MAXIMIZE_CLICKS"; cpcBidCeilingMicros?: string }
  | { kind: "MANUAL_CPC"; enhancedCpcEnabled?: boolean };

/** True when the strategy lets Google set bids, i.e. bid modifiers are inert. */
export const isSmartBidding = (b: BiddingStrategy): boolean => b.kind !== "MANUAL_CPC";

function biddingFields(b: BiddingStrategy): Record<string, unknown> {
  switch (b.kind) {
    case "MAXIMIZE_CONVERSION_VALUE":
      return { maximizeConversionValue: b.targetRoas ? { targetRoas: b.targetRoas } : {} };
    case "MAXIMIZE_CLICKS":
      return {
        targetSpend: b.cpcBidCeilingMicros ? { cpcBidCeilingMicros: b.cpcBidCeilingMicros } : {},
      };
    case "MANUAL_CPC":
      return { manualCpc: { enhancedCpcEnabled: b.enhancedCpcEnabled ?? false } };
  }
}

/** The campaign field name each strategy writes — used to build the update mask. */
function biddingFieldMask(b: BiddingStrategy): string {
  switch (b.kind) {
    case "MAXIMIZE_CONVERSION_VALUE":
      return b.targetRoas ? "maximize_conversion_value.target_roas" : "maximize_conversion_value";
    case "MAXIMIZE_CLICKS":
      return b.cpcBidCeilingMicros ? "target_spend.cpc_bid_ceiling_micros" : "target_spend";
    case "MANUAL_CPC":
      return "manual_cpc.enhanced_cpc_enabled";
  }
}

// ─── Method inputs ────────────────────────────────────────────────────────────────────

export interface CreateBudgetInput {
  name: string;
  amountMicros: string;
  /** STANDARD paces spend evenly; ACCELERATED is removed for most campaign types. */
  deliveryMethod?: "STANDARD";
  explicitlyShared?: boolean;
}

export interface ShoppingSetting {
  merchantId: string;
  /** Replaces the removed `sales_country`. "CA" for the Canadian feed. */
  feedLabel: string;
  /** 0 = LOW, 1 = MEDIUM, 2 = HIGH. Only meaningful with several Shopping campaigns. */
  campaignPriority: 0 | 1 | 2;
  enableLocal?: boolean;
}

export interface CreateCampaignInput {
  name: string;
  budgetResourceName: string;
  bidding: BiddingStrategy;
  advertisingChannelType?: "SHOPPING" | "SEARCH" | "PERFORMANCE_MAX" | "DISPLAY";
  status?: CampaignStatus;
  shoppingSetting?: ShoppingSetting;
  networkSettings?: {
    targetGoogleSearch?: boolean;
    targetSearchNetwork?: boolean;
    targetContentNetwork?: boolean;
    targetPartnerSearchNetwork?: boolean;
  };
}

export interface CreateAdGroupInput {
  name: string;
  campaignResourceName: string;
  type?: "SHOPPING_PRODUCT_ADS" | "SEARCH_STANDARD";
  status?: CampaignStatus;
  /** Ignored unless the campaign bids MANUAL_CPC — written so a later switch is correct. */
  cpcBidMicros?: string;
}

export interface NegativeKeyword {
  text: string;
  matchType: KeywordMatchType;
}

export interface AdScheduleSlot {
  dayOfWeek: DayOfWeek;
  startHour: number;
  endHour: number;
  /** e.g. 1.2 for +20%. Silently inert under smart bidding — the client drops it there. */
  bidModifier?: number;
}

export interface SitelinkInput {
  linkText: string;
  description1?: string;
  description2?: string;
  finalUrl: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────────────

export interface GoogleAdsClientOptions {
  /** Record payloads and send nothing. Credentials are not required. */
  dryRun?: boolean;
  apiVersion?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class GoogleAdsClient {
  readonly dryRun: boolean;
  readonly apiVersion: string;
  /** Every mutate this client made or planned, in order. */
  readonly plan: PlannedMutate[] = [];

  private readonly creds: GoogleAdsCredentials | null;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  private dryRunCounter = 0;

  constructor(creds: GoogleAdsCredentials | null, options: GoogleAdsClientOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.apiVersion = options.apiVersion ?? GOOGLE_ADS_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.creds = creds;
    if (!this.dryRun && !creds) {
      throw new Error(
        "GoogleAdsClient: credentials are required unless dryRun is set. " +
          `Missing: ${missingGoogleAdsEnv().join(", ") || "(unknown)"} — see docs/GOOGLE-ADS-SETUP.md`,
      );
    }
  }

  // ── transport ──────────────────────────────────────────────────────────────────────

  /** Exchange the refresh token for an access token, cached until 60s before expiry. */
  private async getAccessToken(): Promise<string> {
    const creds = this.requireCreds();
    if (this.accessToken && Date.now() < this.accessTokenExpiry) return this.accessToken;
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `OAuth refresh failed (HTTP ${res.status}): ${JSON.stringify(body)}\n` +
          `  If this says 'invalid_scope' or the token was minted for Merchant Center, re-consent ` +
          `with ${GOOGLE_ADS_SCOPE}.`,
      );
    }
    const { access_token, expires_in } = body as { access_token?: string; expires_in?: number };
    if (!access_token) throw new Error(`OAuth refresh returned no access_token: ${JSON.stringify(body)}`);
    this.accessToken = access_token;
    this.accessTokenExpiry = Date.now() + Math.max(0, (expires_in ?? 3600) - 60) * 1000;
    return access_token;
  }

  private requireCreds(): GoogleAdsCredentials {
    if (!this.creds) throw new Error("GoogleAdsClient: no credentials (dry-run only)");
    return this.creds;
  }

  /** POST to a customer-scoped endpoint, with retry on 429/5xx. */
  private async post(path: string, body: unknown, attempt = 0): Promise<unknown> {
    const creds = this.requireCreds();
    const token = await this.getAccessToken();
    const url = `${API_BASE}/${this.apiVersion}/customers/${creds.customerId}/${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": creds.developerToken,
      "Content-Type": "application/json",
    };
    if (creds.loginCustomerId) headers["login-customer-id"] = creds.loginCustomerId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Google Ads request timeout after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.post(path, body, attempt + 1);
    }

    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleAdsApiError(path, res.status, json);
    return json;
  }

  /**
   * Run one mutate. In dry-run, records the payload and returns synthetic resource names
   * shaped like the real ones so downstream steps can reference them.
   */
  private async mutate(step: string, path: string, operations: unknown[]): Promise<string[]> {
    if (this.dryRun) {
      const cid = this.creds?.customerId ?? "DRYRUN";
      const entity = path.replace(/:mutate$/, "");
      const resourceNames = operations.map(
        () => `customers/${cid}/${entity}/${900_000_000 + ++this.dryRunCounter}`,
      );
      this.plan.push({ step, path, operations, resourceNames });
      return resourceNames;
    }
    const result = (await this.post(path, { operations })) as MutateResult;
    const resourceNames = (result.results ?? []).map((r) => r.resourceName);
    this.plan.push({ step, path, operations, resourceNames });
    return resourceNames;
  }

  private static first(names: string[], step: string): string {
    const rn = names[0];
    if (!rn) throw new Error(`${step}: Google Ads returned no resource name`);
    return rn;
  }

  /** GAQL search. Returns [] in dry-run (nothing to query). */
  async search(query: string): Promise<Record<string, unknown>[]> {
    if (this.dryRun) return [];
    const out = (await this.post("googleAds:search", { query })) as { results?: Record<string, unknown>[] };
    return out.results ?? [];
  }

  // ── campaign chain ─────────────────────────────────────────────────────────────────

  /** A campaign cannot exist without a budget, so this comes first in every chain. */
  async createCampaignBudget(input: CreateBudgetInput): Promise<string> {
    const names = await this.mutate("campaign_budget", "campaignBudgets:mutate", [
      {
        create: {
          name: input.name,
          amountMicros: input.amountMicros,
          deliveryMethod: input.deliveryMethod ?? "STANDARD",
          explicitlyShared: input.explicitlyShared ?? false,
        },
      },
    ]);
    return GoogleAdsClient.first(names, "createCampaignBudget");
  }

  /** Create a campaign. Defaults to PAUSED — nothing this client makes ever auto-spends. */
  async createCampaign(input: CreateCampaignInput): Promise<string> {
    const create: Record<string, unknown> = {
      name: input.name,
      status: input.status ?? "PAUSED",
      advertisingChannelType: input.advertisingChannelType ?? "SHOPPING",
      campaignBudget: input.budgetResourceName,
      ...biddingFields(input.bidding),
    };
    if (input.shoppingSetting) {
      create.shoppingSetting = {
        merchantId: input.shoppingSetting.merchantId,
        feedLabel: input.shoppingSetting.feedLabel,
        campaignPriority: input.shoppingSetting.campaignPriority,
        enableLocal: input.shoppingSetting.enableLocal ?? false,
      };
    }
    if (input.networkSettings) create.networkSettings = input.networkSettings;
    const names = await this.mutate("campaign", "campaigns:mutate", [{ create }]);
    return GoogleAdsClient.first(names, "createCampaign");
  }

  /**
   * Switch an existing campaign's bidding strategy. Used to seed a new account on
   * MAXIMIZE_CLICKS and flip it to MAXIMIZE_CONVERSION_VALUE once conversion data exists,
   * without rebuilding the campaign (unlike Meta, Google allows this in place).
   */
  async setCampaignBidding(campaignResourceName: string, bidding: BiddingStrategy): Promise<string> {
    const names = await this.mutate("campaign_bidding", "campaigns:mutate", [
      {
        update: { resourceName: campaignResourceName, ...biddingFields(bidding) },
        updateMask: biddingFieldMask(bidding),
      },
    ]);
    return GoogleAdsClient.first(names, "setCampaignBidding");
  }

  async createAdGroup(input: CreateAdGroupInput): Promise<string> {
    const create: Record<string, unknown> = {
      name: input.name,
      status: input.status ?? "PAUSED",
      campaign: input.campaignResourceName,
      type: input.type ?? "SHOPPING_PRODUCT_ADS",
    };
    if (input.cpcBidMicros) create.cpcBidMicros = input.cpcBidMicros;
    const names = await this.mutate("ad_group", "adGroups:mutate", [{ create }]);
    return GoogleAdsClient.first(names, "createAdGroup");
  }

  /**
   * Create the Shopping product ad AND the listing group that makes it eligible to serve.
   * A `shopping_product_ad` carries no creative — image, title and price all come from the
   * linked Merchant Center item — but without a listing group the ad group matches no
   * product and serves nothing, so the two are always created together. The default is a
   * single root UNIT covering the entire feed ("all products").
   */
  async createShoppingAd(adGroupResourceName: string): Promise<{ ad: string; listingGroup: string }> {
    const adNames = await this.mutate("ad_group_ad", "adGroupAds:mutate", [
      { create: { adGroup: adGroupResourceName, status: "PAUSED", ad: { shoppingProductAd: {} } } },
    ]);
    const lgNames = await this.mutate("listing_group", "adGroupCriteria:mutate", [
      {
        create: {
          adGroup: adGroupResourceName,
          status: "ENABLED",
          listingGroup: { type: "UNIT_INCLUDED" },
        },
      },
    ]);
    return {
      ad: GoogleAdsClient.first(adNames, "createShoppingAd"),
      listingGroup: GoogleAdsClient.first(lgNames, "createShoppingAd/listingGroup"),
    };
  }

  // ── campaign criteria ──────────────────────────────────────────────────────────────

  /**
   * Campaign-level negative keywords. Shopping campaigns take no positive keywords —
   * matching comes from the feed — but negatives are the main lever for cutting junk
   * traffic, so this is where most of the optimisation lives.
   */
  async addNegativeKeywords(
    campaignResourceName: string,
    keywords: NegativeKeyword[],
  ): Promise<string[]> {
    if (keywords.length === 0) return [];
    return this.mutate(
      "negative_keywords",
      "campaignCriteria:mutate",
      keywords.map((k) => ({
        create: {
          campaign: campaignResourceName,
          negative: true,
          keyword: { text: k.text, matchType: k.matchType },
        },
      })),
    );
  }

  async addLocationTargets(campaignResourceName: string, geoTargetConstants: string[]): Promise<string[]> {
    return this.mutate(
      "locations",
      "campaignCriteria:mutate",
      geoTargetConstants.map((geo) => ({
        create: { campaign: campaignResourceName, location: { geoTargetConstant: geo } },
      })),
    );
  }

  async addLanguageTargets(campaignResourceName: string, languageConstants: string[]): Promise<string[]> {
    return this.mutate(
      "languages",
      "campaignCriteria:mutate",
      languageConstants.map((lang) => ({
        create: { campaign: campaignResourceName, language: { languageConstant: lang } },
      })),
    );
  }

  /**
   * Ad schedule. `bidModifier` is dropped when `bidding` is a smart strategy: Google
   * ignores modifiers there, and writing 1.2 into the account would make the UI claim a
   * boost that never applies. Pass MANUAL_CPC for the modifiers to take effect.
   */
  async addAdSchedule(
    campaignResourceName: string,
    slots: AdScheduleSlot[],
    bidding: BiddingStrategy,
  ): Promise<string[]> {
    if (slots.length === 0) return [];
    const honoursModifiers = !isSmartBidding(bidding);
    return this.mutate(
      "ad_schedule",
      "campaignCriteria:mutate",
      slots.map((s) => ({
        create: {
          campaign: campaignResourceName,
          adSchedule: {
            dayOfWeek: s.dayOfWeek,
            startHour: s.startHour,
            startMinute: "ZERO",
            endHour: s.endHour,
            endMinute: "ZERO",
          },
          ...(honoursModifiers && s.bidModifier && s.bidModifier !== 1 ? { bidModifier: s.bidModifier } : {}),
        },
      })),
    );
  }

  /**
   * Sitelink assets linked to the campaign.
   *
   * ⚠ Sitelinks render on SEARCH ads. A Shopping product ad is the product card and shows
   * none of them. They are supported here because the campaign may later run alongside a
   * Search campaign, and because they cost nothing — but they will not appear on Shopping.
   * Shopping promo pricing comes from the Merchant Center promotions feed instead.
   */
  async createSitelinks(campaignResourceName: string, sitelinks: SitelinkInput[]): Promise<string[]> {
    if (sitelinks.length === 0) return [];
    const assetNames = await this.mutate(
      "sitelink_assets",
      "assets:mutate",
      sitelinks.map((s) => ({
        create: {
          name: `Sitelink — ${s.linkText}`,
          finalUrls: [s.finalUrl],
          sitelinkAsset: {
            linkText: s.linkText,
            ...(s.description1 ? { description1: s.description1 } : {}),
            ...(s.description2 ? { description2: s.description2 } : {}),
          },
        },
      })),
    );
    await this.mutate(
      "campaign_sitelinks",
      "campaignAssets:mutate",
      assetNames.map((asset) => ({
        create: { campaign: campaignResourceName, asset, fieldType: "SITELINK", status: "ENABLED" },
      })),
    );
    return assetNames;
  }

  // ── preflight ──────────────────────────────────────────────────────────────────────

  /**
   * Enabled conversion actions on the account. A value-bidding strategy with no
   * value-carrying conversion bids blind, so callers should refuse to build one.
   */
  async listConversionActions(): Promise<
    { name: string; category: string; primaryForGoal: boolean }[]
  > {
    const rows = await this.search(
      `SELECT conversion_action.name, conversion_action.category,
              conversion_action.primary_for_goal, conversion_action.status
       FROM conversion_action WHERE conversion_action.status = 'ENABLED'`,
    );
    return rows.map((r) => {
      const ca = (r.conversionAction ?? {}) as {
        name?: string;
        category?: string;
        primaryForGoal?: boolean;
      };
      return {
        name: ca.name ?? "(unnamed)",
        category: ca.category ?? "UNKNOWN",
        primaryForGoal: ca.primaryForGoal ?? false,
      };
    });
  }
}
