import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fake env so config.ts doesn't throw on the metaAccessToken getter.
process.env.META_ACCESS_TOKEN = "TEST_META_TOKEN";

import {
  getAdAccounts,
  getCampaigns,
  createCampaign,
  createAdSet,
  getInsights,
  uploadAdVideo,
  getAdVideoStatus,
  pollAdVideoReady,
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
      if (urlStr.includes("/adsets") && (init?.method || "GET") === "POST") {
        return new Response(JSON.stringify({ id: "adset_new" }), { status: 200 });
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

  it("createCampaign forwards the PRODUCT_CATALOG_SALES objective for Dynamic Ads", async () => {
    const res = await createCampaign("act_20658834", {
      name: "Ameublo Direct — Retargeting",
      objective: "PRODUCT_CATALOG_SALES",
    });
    expect(res.id).toBe("camp_new");
    const post = calls.find((c) => c.url.includes("/campaigns") && c.method === "POST")!;
    expect(post.url).toContain("/act_20658834/campaigns");
    expect(post.body).toMatchObject({
      name: "Ameublo Direct — Retargeting",
      objective: "PRODUCT_CATALOG_SALES",
      status: "PAUSED",
      special_ad_categories: ["NONE"],
    });
  });

  it("createAdSet POSTs nested targeting + promoted_object with safe defaults", async () => {
    const res = await createAdSet("20658834", {
      campaignId: "camp_new",
      name: "Retargeting — Visiteurs 30j",
      targeting: { geo_locations: { countries: ["CA"] }, custom_audiences: [{ id: "aud_1" }] },
      promotedObject: { product_catalog_id: "1103064966519153" },
    });
    expect(res.id).toBe("adset_new");
    const post = calls.find((c) => c.url.includes("/adsets") && c.method === "POST")!;
    expect(post.url).toContain("/act_20658834/adsets");
    expect(post.body).toMatchObject({
      campaign_id: "camp_new",
      name: "Retargeting — Visiteurs 30j",
      targeting: { geo_locations: { countries: ["CA"] }, custom_audiences: [{ id: "aud_1" }] },
      promoted_object: { product_catalog_id: "1103064966519153" },
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      optimization_goal: "OFFSITE_CONVERSIONS",
      status: "PAUSED",
    });
  });

  it("createAdSet forwards explicit budget/status overrides", async () => {
    await createAdSet("act_111", {
      campaignId: "c1",
      name: "AS",
      targeting: { geo_locations: { countries: ["CA"] } },
      promotedObject: { product_set_id: "ps_1", custom_event_type: "PURCHASE" },
      dailyBudget: 1500,
      status: "ACTIVE",
      optimizationGoal: "VALUE",
    });
    const post = calls.find((c) => c.url.includes("/adsets") && c.method === "POST")!;
    expect(post.body).toMatchObject({ daily_budget: "1500", status: "ACTIVE", optimization_goal: "VALUE" });
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

  it("uploadAdVideo POSTs file_url (+name) to /act_<id>/advideos and returns the video id", async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), method: init?.method || "GET", body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ id: "vid_1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await uploadAdVideo("111", { fileUrl: "https://blob.example/v.mp4", name: "SKU 16:9 15s" });
    expect(res.id).toBe("vid_1");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/act_111/advideos");
    expect(post.body).toMatchObject({ file_url: "https://blob.example/v.mp4", name: "SKU 16:9 15s" });
  });

  it("uploadAdVideo omits name when not provided", async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), method: init?.method || "GET", body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ id: "vid_2" }), { status: 200 });
    }) as unknown as typeof fetch;

    await uploadAdVideo("act_111", { fileUrl: "https://blob.example/v.mp4" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ file_url: "https://blob.example/v.mp4" });
    expect(post.body).not.toHaveProperty("name");
  });

  it("getAdVideoStatus maps video_status ready/processing/error", async () => {
    const mk = (vs: string) =>
      (global.fetch = vi.fn(async (url: string | URL) => {
        calls.push({ url: url.toString(), method: "GET", body: null });
        return new Response(JSON.stringify({ status: { video_status: vs } }), { status: 200 });
      }) as unknown as typeof fetch);

    mk("ready");
    expect((await getAdVideoStatus("vid_1")).status).toBe("ready");
    expect(calls[0].url).toContain("/vid_1");
    expect(decodeURIComponent(calls[0].url)).toContain("fields=status");

    __resetRateLimit();
    mk("processing");
    expect((await getAdVideoStatus("vid_1")).status).toBe("processing");

    __resetRateLimit();
    mk("error");
    expect((await getAdVideoStatus("vid_1")).status).toBe("error");
  });

  it("getAdVideoStatus treats an unknown/missing video_status as processing", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ status: {} }), { status: 200 })) as unknown as typeof fetch;
    expect((await getAdVideoStatus("vid_1")).status).toBe("processing");
  });

  it("pollAdVideoReady resolves once status flips to ready", async () => {
    let n = 0;
    global.fetch = vi.fn(async () => {
      n++;
      const vs = n >= 2 ? "ready" : "processing";
      return new Response(JSON.stringify({ status: { video_status: vs } }), { status: 200 });
    }) as unknown as typeof fetch;

    const info = await pollAdVideoReady("vid_1", { timeoutMs: 5_000, intervalMs: 1 });
    expect(info.status).toBe("ready");
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("pollAdVideoReady throws on a Meta error status", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: { video_status: "error", errors: [{ message: "bad codec" }] } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(pollAdVideoReady("vid_1", { timeoutMs: 5_000, intervalMs: 1 })).rejects.toThrow(/processing failed/i);
  });

  it("pollAdVideoReady throws when the timeout elapses before ready", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: { video_status: "processing" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(pollAdVideoReady("vid_1", { timeoutMs: 5, intervalMs: 1 })).rejects.toThrow(/not ready after/i);
  });
});
