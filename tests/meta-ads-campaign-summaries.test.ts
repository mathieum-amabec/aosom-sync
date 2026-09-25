import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fake env so config.ts doesn't throw on the metaAccessToken getter.
process.env.META_ACCESS_TOKEN = "TEST_META_TOKEN";

import { getActiveCampaignDaySummaries, __resetRateLimit } from "@/lib/meta-ads-client";

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe("getActiveCampaignDaySummaries", () => {
  let originalFetch: typeof fetch;
  let urls: string[];

  beforeEach(() => {
    __resetRateLimit();
    urls = [];
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      urls.push(url);
      if (url.includes("/act_1/campaigns")) {
        return json({ data: [{ id: "c1", name: "Advantage+ Sales", status: "ACTIVE", effective_status: "ACTIVE" }] });
      }
      if (url.includes("/c1/insights")) {
        return json({
          data: [{
            spend: "131.40",
            impressions: "9120",
            inline_link_clicks: "402",
            actions: [
              { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
              { action_type: "omni_purchase", value: "2" },
              { action_type: "link_click", value: "402" },
            ],
            action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "318.5" }],
          }],
        });
      }
      if (url.includes("/c1/adsets")) {
        return json({
          data: [
            { effective_status: "ACTIVE", daily_budget: "14000", learning_stage_info: { status: "LEARNING" } },
            { effective_status: "PAUSED", daily_budget: "5000", learning_stage_info: { status: "SUCCESS" } },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns spend, delivery, pixel purchases and learning for each active campaign on the given day", async () => {
    const rows = await getActiveCampaignDaySummaries("act_1", "2026-09-24");
    expect(rows).toEqual([
      {
        id: "c1",
        name: "Advantage+ Sales",
        dailyBudget: 14000, // paused ad set's budget excluded
        spend: 131.4,
        impressions: 9120,
        linkClicks: 402,
        purchases: 2, // pixel purchases only, not double-counted with omni_purchase
        purchaseValue: 318.5,
        learning: ["LEARNING"], // paused ad set's status excluded
      },
    ]);
    const insightsUrl = new URL(urls.find((u) => u.includes("/c1/insights"))!);
    expect(JSON.parse(insightsUrl.searchParams.get("time_range")!)).toEqual({ since: "2026-09-24", until: "2026-09-24" });
  });

  it("reports zeros when Meta has no insights row for the day (no delivery)", async () => {
    const base = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) =>
      input.toString().includes("/insights") ? json({ data: [] }) : base(input),
    ) as typeof fetch;
    const [row] = await getActiveCampaignDaySummaries("act_1", "2026-09-24");
    expect(row).toMatchObject({ spend: 0, impressions: 0, linkClicks: 0, purchases: 0, purchaseValue: 0 });
  });
});
