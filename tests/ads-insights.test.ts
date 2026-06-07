import { describe, it, expect } from "vitest";
import { aggregateInsights, pickAdAccount, rangeForDays, parseDays } from "@/lib/ads-insights";
import type { InsightsRow, AdAccount } from "@/lib/meta-ads-client";

const acct = (id: string, status: number): AdAccount => ({
  id, account_id: id.replace(/^act_/, ""), name: id, account_status: status, currency: "CAD",
});

describe("pickAdAccount", () => {
  const accts = [acct("act_111", 2), acct("act_222", 1), acct("act_333", 1)];

  it("returns null when there are no accounts", () => {
    expect(pickAdAccount([], "act_222")).toBeNull();
  });
  it("prefers the configured account id (with act_ prefix)", () => {
    expect(pickAdAccount(accts, "act_333")?.id).toBe("act_333");
  });
  it("matches the configured id without the act_ prefix", () => {
    expect(pickAdAccount(accts, "333")?.id).toBe("act_333");
  });
  it("falls back to the first ACTIVE account when no preference is set", () => {
    expect(pickAdAccount(accts)?.id).toBe("act_222"); // act_111 is status 2 (not active)
  });
  it("falls back to ACTIVE when the preferred id isn't accessible", () => {
    expect(pickAdAccount(accts, "act_999")?.id).toBe("act_222");
  });
  it("falls back to the first account when none are active", () => {
    expect(pickAdAccount([acct("act_a", 2), acct("act_b", 3)])?.id).toBe("act_a");
  });
});

describe("aggregateInsights", () => {
  it("computes totals and derived metrics from a single row", () => {
    const rows: InsightsRow[] = [
      { spend: "100", reach: "5000", impressions: "20000", clicks: "400", purchase_roas: [{ action_type: "omni_purchase", value: "3" }] },
    ];
    const m = aggregateInsights(rows);
    expect(m.spend).toBe(100);
    expect(m.reach).toBe(5000);
    expect(m.impressions).toBe(20000);
    expect(m.clicks).toBe(400);
    expect(m.roas).toBe(3);     // revenue 300 / spend 100
    expect(m.cpm).toBe(5);      // 100 / 20000 * 1000
    expect(m.ctr).toBe(2);      // 400 / 20000 * 100
  });

  it("does NOT sum overlapping purchase_roas action types (omni_purchase is canonical)", () => {
    // omni_purchase (3) is a superset of the pixel purchase (2.5); summing would
    // give 5.5 and double-count revenue. Canonical pick must yield 3.
    const m = aggregateInsights([
      {
        spend: "100", impressions: "10000", clicks: "100",
        purchase_roas: [
          { action_type: "offsite_conversion.fb_pixel_purchase", value: "2.5" },
          { action_type: "omni_purchase", value: "3" },
        ],
      },
    ]);
    expect(m.roas).toBe(3);
  });

  it("falls back to the max purchase_roas value when no canonical type is present", () => {
    const m = aggregateInsights([
      { spend: "100", impressions: "10000", clicks: "100", purchase_roas: [{ action_type: "app_custom_event", value: "1.5" }, { action_type: "lead", value: "4" }] },
    ]);
    expect(m.roas).toBe(4); // max, never the sum (5.5)
  });

  it("aggregates multiple rows: sums additive totals, takes max reach, derives ROAS/CPM/CTR from totals", () => {
    const rows: InsightsRow[] = [
      { spend: "100", reach: "5000", impressions: "20000", clicks: "400", purchase_roas: [{ action_type: "omni_purchase", value: "3" }] },
      { spend: "50", reach: "3000", impressions: "10000", clicks: "100", purchase_roas: [{ action_type: "omni_purchase", value: "2" }] },
    ];
    const m = aggregateInsights(rows);
    expect(m.spend).toBe(150);
    expect(m.reach).toBe(5000);   // max, NOT 8000 — reach is not additive
    expect(m.impressions).toBe(30000);
    expect(m.clicks).toBe(500);
    expect(m.roas).toBe(2.67);    // revenue (3*100 + 2*50)=400 / spend 150 = 2.666… → round2
    expect(m.cpm).toBe(5);        // 150 / 30000 * 1000
    expect(m.ctr).toBe(1.67);     // 500 / 30000 * 100 = 1.666… → round2
  });

  it("returns all zeros (no NaN) for empty input", () => {
    expect(aggregateInsights([])).toEqual({ spend: 0, reach: 0, impressions: 0, clicks: 0, roas: 0, cpm: 0, ctr: 0 });
  });

  it("guards divide-by-zero: no impressions → CPM/CTR 0; no conversions → ROAS 0", () => {
    const m = aggregateInsights([{ spend: "25", impressions: "0", clicks: "0" }]);
    expect(m.spend).toBe(25);
    expect(m.cpm).toBe(0);
    expect(m.ctr).toBe(0);
    expect(m.roas).toBe(0); // purchase_roas absent
  });

  it("tolerates missing/garbage numeric fields", () => {
    const m = aggregateInsights([{ spend: undefined, reach: "abc", impressions: "1000", clicks: "10" }]);
    expect(m.spend).toBe(0);
    expect(m.reach).toBe(0);
    expect(m.impressions).toBe(1000);
    expect(m.clicks).toBe(10);
    expect(m.ctr).toBe(1); // 10/1000*100
  });
});

describe("rangeForDays", () => {
  it("builds an inclusive UTC window ending today (30 days = today minus 29)", () => {
    const now = new Date("2026-06-07T12:00:00Z");
    expect(rangeForDays(30, now)).toEqual({ since: "2026-05-09", until: "2026-06-07" });
  });

  it("zero-pads month and day; days=1 yields a single-day range", () => {
    const now = new Date("2026-01-05T00:00:00Z");
    expect(rangeForDays(1, now)).toEqual({ since: "2026-01-05", until: "2026-01-05" });
  });

  it("clamps days into [1, 365]", () => {
    const now = new Date("2026-06-07T12:00:00Z");
    expect(rangeForDays(0, now).since).toBe("2026-06-07");        // clamped to 1
    expect(rangeForDays(10000, now).since).toBe("2025-06-08");    // clamped to 365 (today minus 364)
  });
});

describe("parseDays", () => {
  it("defaults to 30 for null / non-numeric / non-positive", () => {
    expect(parseDays(null)).toBe(30);
    expect(parseDays("abc")).toBe(30);
    expect(parseDays("0")).toBe(30);
    expect(parseDays("-5")).toBe(30);
  });
  it("passes through valid values and clamps to 365", () => {
    expect(parseDays("7")).toBe(7);
    expect(parseDays("30")).toBe(30);
    expect(parseDays("500")).toBe(365);
  });
});
