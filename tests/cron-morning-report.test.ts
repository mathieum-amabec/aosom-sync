import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const envMock = vi.hoisted(() => ({
  cronSecret: "test-secret-123",
  hasMetaAccessToken: true,
  metaAdAccountId: "act_1" as string | undefined,
  morningReportEmail: "mat@example.com" as string | undefined,
}));
vi.mock("@/lib/config", () => ({ env: envMock }));

vi.mock("@/lib/database", () => ({
  recordCronRun: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  countGuidesAwaitingApproval: vi.fn(),
  countContentFormatVideos: vi.fn(),
  countMorningReportAlerts: vi.fn(),
  countAwaitingOperator: vi.fn(),
}));
vi.mock("@/lib/klaviyo-client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/meta-ads-client", () => ({
  getActiveCampaignDaySummaries: vi.fn(),
  getAdAccounts: vi.fn(),
}));

import * as db from "@/lib/database";
import { trackEvent } from "@/lib/klaviyo-client";
import { getActiveCampaignDaySummaries } from "@/lib/meta-ads-client";
import { GET, KLAVIYO_METRIC } from "@/app/api/cron/morning-report/route";

const req = (query = "", secret = "test-secret-123") =>
  new Request(`https://app.test/api/cron/morning-report${query}`, { headers: { Authorization: `Bearer ${secret}` } });

// 10:00 UTC on 2026-09-25 = 06:00 EDT in Montreal.
const SIX_AM_EDT = new Date("2026-09-25T10:00:00Z");
// 11:00 UTC the same day = 07:00 EDT → the "wrong" of the two daily runs in summer.
const SEVEN_AM_EDT = new Date("2026-09-25T11:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIX_AM_EDT);
  envMock.metaAdAccountId = "act_1";
  envMock.morningReportEmail = "mat@example.com";
  vi.mocked(db.getSetting).mockResolvedValue(null);
  vi.mocked(db.countGuidesAwaitingApproval).mockResolvedValue({ pending: 2, ready: 1, attention: 1, attentionTitles: ["X"] });
  vi.mocked(db.countContentFormatVideos).mockResolvedValue({ pendingApproval: 3, scheduledSoon: 5 });
  vi.mocked(db.countMorningReportAlerts).mockResolvedValue({
    priceBelowFloor: 0, priceFloorIncidents24h: 0, imagesPendingReview: 4, importErrors: 0, catalogIssues: 0, unreadNotifications: 0,
  });
  vi.mocked(db.countAwaitingOperator).mockResolvedValue({
    sequentialAds: 16, importsToPush: 0, importsNeedsReview: 1, socialDrafts: 0, blogDrafts: 0,
  });
  vi.mocked(getActiveCampaignDaySummaries).mockResolvedValue([
    { id: "1", name: "Advantage+ Sales", dailyBudget: 14000, spend: 120, impressions: 8000, linkClicks: 400, purchases: 1, purchaseValue: 150, learning: ["LEARNING"] },
  ]);
  vi.mocked(trackEvent).mockResolvedValue({ ok: true, status: 202 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/cron/morning-report", () => {
  it("401s without a valid Bearer token and reads/sends nothing", async () => {
    const res = await GET(req("", "wrong"));
    expect(res.status).toBe(401);
    expect(trackEvent).not.toHaveBeenCalled();
    expect(db.countGuidesAwaitingApproval).not.toHaveBeenCalled();
  });

  it("at 06:00 Montreal: sends ONE Klaviyo event to the recipient and records the day", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, sent: true, date: "2026-09-25" });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    const [metric, email, props] = vi.mocked(trackEvent).mock.calls[0];
    expect(metric).toBe(KLAVIYO_METRIC);
    expect(email).toBe("mat@example.com");
    expect(props).toMatchObject({ report_date: "2026-09-25", missing_sections: [] });
    expect(String((props as Record<string, unknown>).subject)).toContain("Rapport du matin");
    expect(String((props as Record<string, unknown>).body_html)).toContain("Advantage+ Sales");
    expect(getActiveCampaignDaySummaries).toHaveBeenCalledWith("act_1", "2026-09-24");
    expect(db.setSetting).toHaveBeenCalledWith("morning_report_last_sent", "2026-09-25");
    expect(db.recordCronRun).toHaveBeenCalledWith("morning-report", "success", expect.stringContaining("sent for 2026-09-25"));
  });

  it("the other daily run (07:00 Montreal in summer) skips without reading or sending", async () => {
    vi.setSystemTime(SEVEN_AM_EDT);
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ success: true, skipped: "not-06h", montrealHour: 7 });
    expect(trackEvent).not.toHaveBeenCalled();
    expect(db.countGuidesAwaitingApproval).not.toHaveBeenCalled();
  });

  it("sends at 11:00 UTC in winter (06:00 EST)", async () => {
    vi.setSystemTime(new Date("2026-12-15T11:00:00Z"));
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ sent: true, date: "2026-12-15" });
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("never sends twice the same day (duplicate / retried invocation)", async () => {
    vi.mocked(db.getSetting).mockResolvedValue("2026-09-25");
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ success: true, skipped: "already-sent" });
    expect(trackEvent).not.toHaveBeenCalled();
    expect(db.setSetting).not.toHaveBeenCalled();
  });

  it("still sends when Meta is down, flagging the missing section", async () => {
    vi.mocked(getActiveCampaignDaySummaries).mockRejectedValue(new Error("Meta Ads API: Service unavailable (code 2)"));
    const body = await (await GET(req())).json();
    expect(body.sent).toBe(true);
    const props = vi.mocked(trackEvent).mock.calls[0][2] as Record<string, unknown>;
    expect(props.missing_sections).toEqual(["Publicités Meta — jeudi 24 septembre"]);
    expect(String(props.subject)).toContain("section indisponible");
    expect(String(props.body_text)).toContain("Section indisponible (Meta Ads API: Service unavailable (code 2))");
    expect(String(props.body_text)).toContain("2 guides en attente");
  });

  it("returns 500 and does NOT mark the day sent when Klaviyo rejects the event (next run retries)", async () => {
    vi.mocked(trackEvent).mockResolvedValue({ ok: false, status: 400, error: "Klaviyo 400" });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(db.setSetting).not.toHaveBeenCalled();
    expect(db.recordCronRun).toHaveBeenCalledWith("morning-report", "error", expect.stringContaining("Klaviyo 400"));
  });

  it("returns 500 (visible in cron_runs) when no recipient is configured", async () => {
    envMock.morningReportEmail = undefined;
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("?dryRun=1 renders the report but sends and records nothing", async () => {
    vi.setSystemTime(SEVEN_AM_EDT); // bypasses the hour gate too
    const body = await (await GET(req("?dryRun=1"))).json();
    expect(body).toMatchObject({ success: true, dryRun: true });
    expect(body.text).toContain("Publicités séquentielles à approuver : 16");
    expect(trackEvent).not.toHaveBeenCalled();
    expect(db.setSetting).not.toHaveBeenCalled();
    expect(db.recordCronRun).not.toHaveBeenCalled();
  });

  it("?force=1 sends outside 06:00 and even if already sent today (manual resend)", async () => {
    vi.setSystemTime(SEVEN_AM_EDT);
    vi.mocked(db.getSetting).mockResolvedValue("2026-09-25");
    const body = await (await GET(req("?force=1"))).json();
    expect(body.sent).toBe(true);
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
