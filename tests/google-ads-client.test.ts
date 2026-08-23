import { describe, it, expect, vi } from "vitest";
import {
  GoogleAdsClient,
  GoogleAdsApiError,
  readGoogleAdsCredentials,
  missingGoogleAdsEnv,
  normalizeCustomerId,
  isSmartBidding,
  toMicros,
  GOOGLE_ADS_SCOPE,
  GOOGLE_ADS_API_VERSION,
  type GoogleAdsCredentials,
  type BiddingStrategy,
} from "@/lib/google-ads-client";

const CREDS: GoogleAdsCredentials = {
  developerToken: "dev-token",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  customerId: "1234567890",
};

/** Shorthand: a dry-run client needs no credentials at all. */
const dry = () => new GoogleAdsClient(null, { dryRun: true });

/** The `create` body of operation `i` of the step named `step`. */
function createdBody(client: GoogleAdsClient, step: string, i = 0): Record<string, unknown> {
  const entry = client.plan.find((p) => p.step === step);
  if (!entry) throw new Error(`step "${step}" not in plan: ${client.plan.map((p) => p.step).join(", ")}`);
  const op = entry.operations[i] as { create: Record<string, unknown> };
  return op.create;
}

describe("normalizeCustomerId", () => {
  it("strips the dashes Google Ads shows in its UI", () => {
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
  });
  it("leaves an already-clean id alone", () => {
    expect(normalizeCustomerId("1234567890")).toBe("1234567890");
  });
});

describe("toMicros", () => {
  it("converts currency units to micros", () => {
    expect(toMicros(15)).toBe("15000000");
    expect(toMicros(1.5)).toBe("1500000");
  });
  it("rounds rather than truncating sub-micro fractions", () => {
    expect(toMicros(0.0000005)).toBe("1");
  });
});

describe("readGoogleAdsCredentials", () => {
  it("returns null when anything required is missing", () => {
    expect(readGoogleAdsCredentials({})).toBeNull();
    expect(
      readGoogleAdsCredentials({
        GOOGLE_ADS_DEVELOPER_TOKEN: "d",
        GOOGLE_ADS_CLIENT_ID: "c",
        GOOGLE_ADS_CLIENT_SECRET: "s",
        GOOGLE_ADS_REFRESH_TOKEN: "r",
        // no customer id
      }),
    ).toBeNull();
  });

  it("reads the Ads-specific names and normalizes the customer id", () => {
    const creds = readGoogleAdsCredentials({
      GOOGLE_ADS_DEVELOPER_TOKEN: "d",
      GOOGLE_ADS_CLIENT_ID: "c",
      GOOGLE_ADS_CLIENT_SECRET: "s",
      GOOGLE_ADS_REFRESH_TOKEN: "r",
      GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-888-7777",
    });
    expect(creds?.customerId).toBe("1234567890");
    expect(creds?.loginCustomerId).toBe("9998887777");
  });

  it("omits loginCustomerId when there is no MCC", () => {
    const creds = readGoogleAdsCredentials({
      GOOGLE_ADS_DEVELOPER_TOKEN: "d",
      GOOGLE_ADS_CLIENT_ID: "c",
      GOOGLE_ADS_CLIENT_SECRET: "s",
      GOOGLE_ADS_REFRESH_TOKEN: "r",
      GOOGLE_ADS_CUSTOMER_ID: "1234567890",
    });
    expect(creds).not.toBeNull();
    expect(creds).not.toHaveProperty("loginCustomerId");
  });

  it("falls back to the generic GOOGLE_* OAuth names", () => {
    const creds = readGoogleAdsCredentials({
      GOOGLE_ADS_DEVELOPER_TOKEN: "d",
      GOOGLE_CLIENT_ID: "generic-id",
      GOOGLE_CLIENT_SECRET: "generic-secret",
      GOOGLE_REFRESH_TOKEN: "generic-refresh",
      GOOGLE_ADS_CUSTOMER_ID: "1234567890",
    });
    expect(creds?.clientId).toBe("generic-id");
    expect(creds?.refreshToken).toBe("generic-refresh");
  });

  it("prefers the Ads-specific name over the generic one", () => {
    const creds = readGoogleAdsCredentials({
      GOOGLE_ADS_DEVELOPER_TOKEN: "d",
      GOOGLE_ADS_CLIENT_ID: "ads-id",
      GOOGLE_CLIENT_ID: "generic-id",
      GOOGLE_ADS_CLIENT_SECRET: "s",
      GOOGLE_ADS_REFRESH_TOKEN: "r",
      GOOGLE_ADS_CUSTOMER_ID: "1234567890",
    });
    expect(creds?.clientId).toBe("ads-id");
  });
});

describe("missingGoogleAdsEnv", () => {
  it("lists every missing key against an empty env", () => {
    expect(missingGoogleAdsEnv({})).toEqual([
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN",
      "GOOGLE_ADS_CUSTOMER_ID",
    ]);
  });

  it("counts a generic alias as satisfying the Ads-specific key", () => {
    expect(
      missingGoogleAdsEnv({
        GOOGLE_ADS_DEVELOPER_TOKEN: "d",
        GOOGLE_CLIENT_ID: "c",
        GOOGLE_CLIENT_SECRET: "s",
        GOOGLE_REFRESH_TOKEN: "r",
        GOOGLE_ADS_CUSTOMER_ID: "1234567890",
      }),
    ).toEqual([]);
  });
});

describe("constructor", () => {
  it("refuses to build a live client without credentials", () => {
    expect(() => new GoogleAdsClient(null)).toThrow(/credentials are required/i);
  });
  it("builds a dry-run client without credentials", () => {
    expect(() => dry()).not.toThrow();
  });
});

describe("dry-run", () => {
  it("sends nothing and records every mutate in order", async () => {
    const fetchImpl = vi.fn();
    const client = new GoogleAdsClient(null, { dryRun: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const budget = await client.createCampaignBudget({ name: "B", amountMicros: toMicros(15) });
    await client.createCampaign({
      name: "C",
      budgetResourceName: budget,
      bidding: { kind: "MAXIMIZE_CONVERSION_VALUE" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.plan.map((p) => p.step)).toEqual(["campaign_budget", "campaign"]);
  });

  it("returns distinct synthetic resource names that downstream steps reference", async () => {
    const client = dry();
    const budget = await client.createCampaignBudget({ name: "B", amountMicros: "1" });
    const campaign = await client.createCampaign({
      name: "C",
      budgetResourceName: budget,
      bidding: { kind: "MANUAL_CPC" },
    });
    expect(budget).not.toBe(campaign);
    expect(createdBody(client, "campaign").campaignBudget).toBe(budget);
  });

  it("search returns no rows (nothing to query)", async () => {
    await expect(dry().search("SELECT campaign.id FROM campaign")).resolves.toEqual([]);
  });
});

describe("createCampaign", () => {
  it("defaults to PAUSED so nothing can auto-spend", async () => {
    const client = dry();
    await client.createCampaign({
      name: "C",
      budgetResourceName: "b",
      bidding: { kind: "MAXIMIZE_CONVERSION_VALUE" },
    });
    expect(createdBody(client, "campaign").status).toBe("PAUSED");
  });

  it("maps MAXIMIZE_CONVERSION_VALUE with and without a tROAS", async () => {
    const a = dry();
    await a.createCampaign({ name: "C", budgetResourceName: "b", bidding: { kind: "MAXIMIZE_CONVERSION_VALUE" } });
    expect(createdBody(a, "campaign").maximizeConversionValue).toEqual({});

    const b = dry();
    await b.createCampaign({
      name: "C",
      budgetResourceName: "b",
      bidding: { kind: "MAXIMIZE_CONVERSION_VALUE", targetRoas: 3.5 },
    });
    expect(createdBody(b, "campaign").maximizeConversionValue).toEqual({ targetRoas: 3.5 });
  });

  it("maps MAXIMIZE_CLICKS to target_spend with the CPC ceiling", async () => {
    const client = dry();
    await client.createCampaign({
      name: "C",
      budgetResourceName: "b",
      bidding: { kind: "MAXIMIZE_CLICKS", cpcBidCeilingMicros: toMicros(1.5) },
    });
    expect(createdBody(client, "campaign").targetSpend).toEqual({ cpcBidCeilingMicros: "1500000" });
  });

  it("carries the shopping setting through verbatim", async () => {
    const client = dry();
    await client.createCampaign({
      name: "C",
      budgetResourceName: "b",
      bidding: { kind: "MANUAL_CPC" },
      shoppingSetting: { merchantId: "5804673777", feedLabel: "CA", campaignPriority: 1 },
    });
    expect(createdBody(client, "campaign").shoppingSetting).toEqual({
      merchantId: "5804673777",
      feedLabel: "CA",
      campaignPriority: 1,
      enableLocal: false,
    });
  });
});

describe("API version", () => {
  // v21 was retired: googleads.googleapis.com answers a retired version with a plain HTML
  // 404, so the client reports "HTTP 404" and the real cause (dead version) is invisible.
  // Probed live 2026-08-23 — v22 answers, v21/v20/v19 do not.
  it("is pinned to a version Google still serves", () => {
    expect(GOOGLE_ADS_API_VERSION).toBe("v22");
  });

  it("puts the pinned version in the request path", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [{ resourceName: "customers/1/campaignBudgets/9" }] }), { status: 200 });
    });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.createCampaignBudget({ name: "B", amountMicros: "1" });

    const apiCall = fetchImpl.mock.calls.find(([u]) => String(u).includes("googleads.googleapis.com"));
    expect(String(apiCall?.[0])).toContain("/" + GOOGLE_ADS_API_VERSION + "/");
  });

  it("still honours an explicit override", () => {
    expect(new GoogleAdsClient(null, { dryRun: true, apiVersion: "v23" }).apiVersion).toBe("v23");
  });
});

describe("EU political advertising declaration", () => {
  // Required on campaign create since v22 (Regulation (EU) 2024/900). Absent, the API
  // rejects the whole create with REQUIRED on contains_eu_political_advertising — which is
  // what broke the first live run of create-google-shopping-campaign.
  it("declares DOES_NOT_CONTAIN by default", async () => {
    const client = dry();
    await client.createCampaign({
      name: "C",
      budgetResourceName: "b",
      bidding: { kind: "MAXIMIZE_CLICKS" },
    });
    expect(createdBody(client, "campaign").containsEuPoliticalAdvertising).toBe(
      "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    );
  });

  it("never omits the field, whatever the bidding strategy", async () => {
    for (const bidding of [
      { kind: "MAXIMIZE_CLICKS" },
      { kind: "MAXIMIZE_CONVERSION_VALUE" },
      { kind: "MANUAL_CPC" },
    ] as BiddingStrategy[]) {
      const client = dry();
      await client.createCampaign({ name: "C", budgetResourceName: "b", bidding });
      expect(createdBody(client, "campaign")).toHaveProperty("containsEuPoliticalAdvertising");
    }
  });

  it("can be overridden for an advertiser that does run political ads", async () => {
    const client = dry();
    await client.createCampaign({
      name: "C",
      budgetResourceName: "b",
      bidding: { kind: "MAXIMIZE_CLICKS" },
      containsEuPoliticalAdvertising: "CONTAINS_EU_POLITICAL_ADVERTISING",
    });
    expect(createdBody(client, "campaign").containsEuPoliticalAdvertising).toBe(
      "CONTAINS_EU_POLITICAL_ADVERTISING",
    );
  });
});

describe("setCampaignBidding", () => {
  it("emits an update with the matching field mask", async () => {
    const client = dry();
    await client.setCampaignBidding("customers/1/campaigns/2", { kind: "MAXIMIZE_CONVERSION_VALUE" });
    const op = client.plan[0]?.operations[0] as { update: Record<string, unknown>; updateMask: string };
    expect(op.update.resourceName).toBe("customers/1/campaigns/2");
    expect(op.updateMask).toBe("maximize_conversion_value");
  });

  it("masks the nested target_roas field when a tROAS is set", async () => {
    const client = dry();
    await client.setCampaignBidding("c", { kind: "MAXIMIZE_CONVERSION_VALUE", targetRoas: 4 });
    const op = client.plan[0]?.operations[0] as { updateMask: string };
    expect(op.updateMask).toBe("maximize_conversion_value.target_roas");
  });
});

describe("isSmartBidding", () => {
  it("is true for the automated strategies and false for manual", () => {
    expect(isSmartBidding({ kind: "MAXIMIZE_CONVERSION_VALUE" })).toBe(true);
    expect(isSmartBidding({ kind: "MAXIMIZE_CLICKS" })).toBe(true);
    expect(isSmartBidding({ kind: "MANUAL_CPC" })).toBe(false);
  });
});

describe("addAdSchedule", () => {
  const slots = [
    { dayOfWeek: "MONDAY" as const, startHour: 0, endHour: 18 },
    { dayOfWeek: "MONDAY" as const, startHour: 18, endHour: 22, bidModifier: 1.2 },
  ];

  it("keeps the bid modifier under MANUAL_CPC", async () => {
    const client = dry();
    await client.addAdSchedule("c", slots, { kind: "MANUAL_CPC" });
    expect(createdBody(client, "ad_schedule", 1).bidModifier).toBe(1.2);
  });

  it.each<BiddingStrategy>([{ kind: "MAXIMIZE_CONVERSION_VALUE" }, { kind: "MAXIMIZE_CLICKS" }])(
    "drops the bid modifier under $kind, which ignores it",
    async (bidding) => {
      const client = dry();
      await client.addAdSchedule("c", slots, bidding);
      // The slot is still created — 24/7 coverage is real — but without a boost the
      // account would display and never apply.
      expect(createdBody(client, "ad_schedule", 1)).not.toHaveProperty("bidModifier");
      expect(createdBody(client, "ad_schedule", 1).adSchedule).toEqual({
        dayOfWeek: "MONDAY",
        startHour: 18,
        startMinute: "ZERO",
        endHour: 22,
        endMinute: "ZERO",
      });
    },
  );

  it("never writes a no-op modifier of exactly 1", async () => {
    const client = dry();
    await client.addAdSchedule(
      "c",
      [{ dayOfWeek: "SUNDAY", startHour: 0, endHour: 24, bidModifier: 1 }],
      { kind: "MANUAL_CPC" },
    );
    expect(createdBody(client, "ad_schedule")).not.toHaveProperty("bidModifier");
  });

  it("plans nothing for an empty schedule", async () => {
    const client = dry();
    await expect(client.addAdSchedule("c", [], { kind: "MANUAL_CPC" })).resolves.toEqual([]);
    expect(client.plan).toHaveLength(0);
  });
});

describe("addNegativeKeywords", () => {
  it("marks every criterion negative", async () => {
    const client = dry();
    await client.addNegativeKeywords("c", [
      { text: "walmart", matchType: "PHRASE" },
      { text: "amazon", matchType: "PHRASE" },
    ]);
    const entry = client.plan[0];
    expect(entry?.operations).toHaveLength(2);
    expect(createdBody(client, "negative_keywords")).toEqual({
      campaign: "c",
      negative: true,
      keyword: { text: "walmart", matchType: "PHRASE" },
    });
  });

  it("plans nothing for an empty list", async () => {
    const client = dry();
    await expect(client.addNegativeKeywords("c", [])).resolves.toEqual([]);
    expect(client.plan).toHaveLength(0);
  });
});

describe("createShoppingAd", () => {
  it("creates the ad AND the listing group that makes it eligible to serve", async () => {
    const client = dry();
    const { ad, listingGroup } = await client.createShoppingAd("customers/1/adGroups/2");
    expect(client.plan.map((p) => p.step)).toEqual(["ad_group_ad", "listing_group"]);
    expect(ad).not.toBe(listingGroup);
    expect(createdBody(client, "ad_group_ad").ad).toEqual({ shoppingProductAd: {} });
    expect(createdBody(client, "listing_group").listingGroup).toEqual({ type: "UNIT_INCLUDED" });
  });
});

describe("createSitelinks", () => {
  it("creates the assets then links each one to the campaign", async () => {
    const client = dry();
    const assets = await client.createSitelinks("customers/1/campaigns/2", [
      { linkText: "Rabais", finalUrl: "https://ameublodirect.ca/collections/rabais" },
    ]);
    expect(client.plan.map((p) => p.step)).toEqual(["sitelink_assets", "campaign_sitelinks"]);
    expect(createdBody(client, "campaign_sitelinks")).toEqual({
      campaign: "customers/1/campaigns/2",
      asset: assets[0],
      fieldType: "SITELINK",
      status: "ENABLED",
    });
  });

  it("omits absent descriptions rather than sending empty strings", async () => {
    const client = dry();
    await client.createSitelinks("c", [{ linkText: "Rabais", finalUrl: "https://x.test" }]);
    expect(createdBody(client, "sitelink_assets").sitelinkAsset).toEqual({ linkText: "Rabais" });
  });

  it("plans nothing for an empty list", async () => {
    const client = dry();
    await expect(client.createSitelinks("c", [])).resolves.toEqual([]);
    expect(client.plan).toHaveLength(0);
  });
});

describe("live transport", () => {
  /** Minimal fake: first call is the OAuth refresh, the rest are API calls. */
  function fakeFetch(apiResponse: { ok: boolean; status: number; body: unknown }) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(apiResponse.body), { status: apiResponse.status });
    });
  }

  it("sends the developer-token and login-customer-id headers", async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      status: 200,
      body: { results: [{ resourceName: "customers/1/campaignBudgets/9" }] },
    });
    const client = new GoogleAdsClient(
      { ...CREDS, loginCustomerId: "9998887777" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await client.createCampaignBudget({ name: "B", amountMicros: "1" });

    const apiCall = fetchImpl.mock.calls.find(([u]) => String(u).includes("googleads.googleapis.com"));
    const headers = (apiCall?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["developer-token"]).toBe("dev-token");
    expect(headers["login-customer-id"]).toBe("9998887777");
    expect(headers.Authorization).toBe("Bearer at");
    expect(String(apiCall?.[0])).toContain("/customers/1234567890/campaignBudgets:mutate");
  });

  it("omits login-customer-id when there is no MCC", async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { results: [{ resourceName: "rn" }] } });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.createCampaignBudget({ name: "B", amountMicros: "1" });
    const apiCall = fetchImpl.mock.calls.find(([u]) => String(u).includes("googleads.googleapis.com"));
    const headers = (apiCall?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("login-customer-id");
  });

  it("reuses the cached access token across calls", async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { results: [{ resourceName: "rn" }] } });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.createCampaignBudget({ name: "B", amountMicros: "1" });
    await client.createCampaignBudget({ name: "B2", amountMicros: "2" });
    const oauthCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("oauth2.googleapis.com"));
    expect(oauthCalls).toHaveLength(1);
  });

  it("flattens Google's nested error envelope into a readable message", async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 400,
      body: {
        error: {
          details: [
            {
              errors: [
                {
                  errorCode: { campaignError: "DUPLICATE_CAMPAIGN_NAME" },
                  message: "A campaign with this name already exists.",
                  location: { fieldPathElements: [{ fieldName: "operations" }, { fieldName: "name" }] },
                },
              ],
            },
          ],
        },
      },
    });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createCampaignBudget({ name: "B", amountMicros: "1" })).rejects.toThrow(
      GoogleAdsApiError,
    );
    await expect(client.createCampaignBudget({ name: "B", amountMicros: "1" })).rejects.toThrow(
      // [\s\S] rather than the /s flag — tsconfig targets ES2017, which predates dotAll.
      /DUPLICATE_CAMPAIGN_NAME[\s\S]*already exists[\s\S]*operations\.name/,
    );
  });

  it("points at the scope mismatch when the OAuth refresh fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 }));
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createCampaignBudget({ name: "B", amountMicros: "1" })).rejects.toThrow(
      new RegExp(GOOGLE_ADS_SCOPE.replace(/[/.]/g, "\\$&")),
    );
  });

  it("retries a 429 and succeeds on the follow-up", async () => {
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      apiCalls += 1;
      if (apiCalls === 1) return new Response(JSON.stringify({}), { status: 429 });
      return new Response(JSON.stringify({ results: [{ resourceName: "rn" }] }), { status: 200 });
    });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createCampaignBudget({ name: "B", amountMicros: "1" })).resolves.toBe("rn");
    expect(apiCalls).toBe(2);
    // One plan entry, not two — a retry is the same logical mutate.
    expect(client.plan).toHaveLength(1);
  }, 10_000);

  it("gives up after the retry budget and surfaces the error", async () => {
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      apiCalls += 1;
      return new Response(JSON.stringify({}), { status: 503 });
    });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createCampaignBudget({ name: "B", amountMicros: "1" })).rejects.toThrow(
      GoogleAdsApiError,
    );
    expect(apiCalls).toBe(4); // initial + MAX_RETRIES(3)
    expect(client.plan).toHaveLength(0); // a failed mutate is never recorded as planned
  }, 20_000);

  it("parses conversion actions for the preflight", async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      status: 200,
      body: {
        results: [
          { conversionAction: { name: "Purchase", category: "PURCHASE", primaryForGoal: true } },
          { conversionAction: { name: "Lead" } },
        ],
      },
    });
    const client = new GoogleAdsClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listConversionActions()).resolves.toEqual([
      { name: "Purchase", category: "PURCHASE", primaryForGoal: true },
      { name: "Lead", category: "UNKNOWN", primaryForGoal: false },
    ]);
  });
});
