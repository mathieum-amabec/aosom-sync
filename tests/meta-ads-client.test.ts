import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fake env so config.ts doesn't throw on the metaAccessToken getter.
process.env.META_ACCESS_TOKEN = "TEST_META_TOKEN";

import {
  getAdAccounts,
  getCampaigns,
  createCampaign,
  getInsights,
  __resetRateLimit,
} from "@/lib/meta-ads-client";
import { META_ADS } from "@/lib/config";

interface FakeCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

describe("meta-ads-client", () => {
  let calls: FakeCall[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    __resetRateLimit();
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url: urlStr, method: init?.method || "GET", body });

      if (urlStr.includes("/me/adaccounts")) {
        return new Response(
          JSON.stringify({ data: [{ id: "act_111", account_id: "111", name: "Main", account_status: 1, currency: "CAD" }] }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/campaigns") && (init?.method || "GET") === "POST") {
        return new Response(JSON.stringify({ id: "camp_new" }), { status: 200 });
      }
      if (urlStr.includes("/campaigns")) {
        return new Response(JSON.stringify({ data: [{ id: "camp_1", name: "C1", status: "ACTIVE" }] }), { status: 200 });
      }
      if (urlStr.includes("/insights")) {
        return new Response(JSON.stringify({ data: [{ spend: "12.34", reach: "100", clicks: "5" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("getAdAccounts hits v18.0 graph with the access token and returns accounts", async () => {
    const accounts = await getAdAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("act_111");
    expect(calls[0].url).toContain("graph.facebook.com/v18.0/me/adaccounts");
    expect(calls[0].url).toContain("access_token=TEST_META_TOKEN");
  });

  it("getCampaigns normalizes a bare account id to act_ and filters effective_status ACTIVE", async () => {
    const campaigns = await getCampaigns("222");
    expect(campaigns[0].id).toBe("camp_1");
    expect(calls[0].url).toContain("/act_222/campaigns");
    expect(decodeURIComponent(calls[0].url)).toContain(`effective_status=["ACTIVE"]`);
  });

  it("getCampaigns keeps an already-prefixed act_ id intact", async () => {
    await getCampaigns("act_333");
    expect(calls[0].url).toContain("/act_333/campaigns");
    expect(calls[0].url).not.toContain("act_act_");
  });

  it("createCampaign POSTs and defaults to PAUSED + NONE special category", async () => {
    const res = await createCampaign("act_111", { name: "Test", objective: "OUTCOME_TRAFFIC" });
    expect(res.id).toBe("camp_new");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      name: "Test",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: ["NONE"],
    });
  });

  it("createCampaign forwards an explicit ACTIVE status and daily budget", async () => {
    await createCampaign("act_111", { name: "T", objective: "OUTCOME_SALES", status: "ACTIVE", dailyBudget: 2000 });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ status: "ACTIVE", daily_budget: "2000" });
  });

  it("getInsights passes a time_range and returns metric rows", async () => {
    const rows = await getInsights("act_111", { since: "2026-06-01", until: "2026-06-30" });
    expect(rows[0].spend).toBe("12.34");
    expect(decodeURIComponent(calls[0].url)).toContain(`time_range={"since":"2026-06-01","until":"2026-06-30"}`);
    expect(calls[0].url).toContain("purchase_roas");
  });

  it("surfaces a Graph API error message", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid token", code: 190 } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(getAdAccounts()).rejects.toThrow(/Invalid token.*190/);
  });

  it("enforces the hourly rate-limit guardrail", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    for (let i = 0; i < META_ADS.RATE_LIMIT_PER_HOUR; i++) {
      await getAdAccounts();
    }
    await expect(getAdAccounts()).rejects.toThrow(/rate limit reached/i);
  });
});
