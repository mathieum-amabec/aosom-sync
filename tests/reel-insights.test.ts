import { describe, it, expect, vi } from "vitest";
import type { ReelResultRow } from "@/lib/database";

vi.mock("@/lib/facebook-client", () => ({ facebookBrandCreds: vi.fn(() => ({ pageId: "p", token: "TOK", label: "Ameublo" })) }));

import { parseReelInsights, summarizeReels, slotOf, LOW_SAMPLE, MATURE_HOURS } from "@/lib/reel-insights";
import { fetchFacebookReelInsights } from "@/lib/reel-insights-client";
import { styleLabelOf } from "@/lib/ameublo-style-label";

const graph = (metrics: Record<string, unknown>) => ({ data: Object.entries(metrics).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })) });

describe("parseReelInsights", () => {
  it("maps the Graph metrics and sums the social actions", () => {
    expect(
      parseReelInsights(graph({ fb_reels_total_plays: 4, blue_reels_play_count: 3, post_video_avg_time_watched: 3929, post_video_view_time: 11789, post_video_social_actions: { LIKE: 2, SHARE: 1 } })),
    ).toEqual({ plays: 4, initialPlays: 3, avgWatchMs: 3929, totalWatchMs: 11789, socialActions: 3 });
  });
  it("treats an empty social-actions object as zero, and a missing metric as null", () => {
    const m = parseReelInsights(graph({ fb_reels_total_plays: 0, post_video_social_actions: {} }));
    expect(m).toMatchObject({ plays: 0, socialActions: 0, avgWatchMs: null, initialPlays: null });
  });
  it("survives garbage", () => {
    expect(parseReelInsights(null)).toEqual({ plays: null, initialPlays: null, avgWatchMs: null, totalWatchMs: null, socialActions: null });
    expect(parseReelInsights({ data: "nope" })).toMatchObject({ plays: null });
  });
});

describe("fetchFacebookReelInsights", () => {
  const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  it("asks for all metrics in ONE call with the page token in a header, not the URL", async () => {
    const f = vi.fn(async () => res(graph({ fb_reels_total_plays: 7 })));
    const m = await fetchFacebookReelInsights("VID1", "ameublo", { fetchImpl: f as unknown as typeof fetch });
    expect(m.plays).toBe(7);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/VID1/video_insights?metric=fb_reels_total_plays,blue_reels_play_count,post_video_avg_time_watched,post_video_view_time,post_video_social_actions");
    expect(url).not.toContain("TOK");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOK");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("when Meta retires one metric (error 100), keeps the ones that still exist instead of losing the snapshot", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes(",")) return res({ error: { code: 100, message: "(#100) The value must be a valid insights metric" } }, 400);
      if (url.includes("post_video_view_time")) return res({ error: { code: 100, message: "retired" } }, 400);
      const name = new URL(url).searchParams.get("metric")!;
      return res(graph({ [name]: name === "post_video_social_actions" ? {} : 5 }));
    });
    const m = await fetchFacebookReelInsights("VID1", "ameublo", { fetchImpl: f as unknown as typeof fetch });
    expect(m).toMatchObject({ plays: 5, initialPlays: 5, avgWatchMs: 5, totalWatchMs: null, socialActions: 0 });
  });

  it("throws with Meta's message when nothing comes back (expired token, deleted video)", async () => {
    const f = vi.fn(async () => res({ error: { code: 190, message: "Error validating access token" } }, 400));
    await expect(fetchFacebookReelInsights("VID1", "furnish", { fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/VID1.*Error validating access token/);
  });
});

const row = (o: Partial<ReelResultRow> = {}): ReelResultRow => ({
  queueId: 1, contentType: "sequential_ad", style: "vitrine", lang: "fr", label: "L", studioVideoId: 1,
  scheduledAt: "2026-10-06 11:45:00", publishedAt: "2026-10-06 11:46:00", plays: 10, avgWatchMs: 4000, totalWatchMs: 40000, socialActions: 0, measuredOn: "2026-10-07", ageHours: 100, ...o,
});

describe("slotOf (Toronto time)", () => {
  it("recognises the four grid slots, FR and EN (+5 min)", () => {
    expect(slotOf("2026-10-06 10:00:00")).toBe("06:00");
    expect(slotOf("2026-10-06 10:05:00")).toBe("06:00");
    expect(slotOf("2026-10-06 11:45:00")).toBe("07:45");
    expect(slotOf("2026-10-06 11:50:00")).toBe("07:45");
    expect(slotOf("2026-10-06 16:15:00")).toBe("12:15");
    expect(slotOf("2026-10-06 23:50:00")).toBe("19:45");
  });
  it("names any other time by its hour, and follows daylight saving", () => {
    expect(slotOf("2026-10-06 13:00:00")).toBe("09h");
    expect(slotOf("2026-11-10 12:45:00")).toBe("07:45"); // EST: 07:45 Toronto = 12:45 UTC
  });
});

describe("summarizeReels", () => {
  it("totals, ranks the groups by average plays, and counts each group's Reels", () => {
    const rows = [
      row({ queueId: 1, style: "vitrine", plays: 10 }),
      row({ queueId: 2, style: "vitrine", plays: 30 }),
      row({ queueId: 3, style: "vote", plays: 100, lang: "en" }),
    ];
    const s = summarizeReels(rows);
    expect(s.measured).toBe(3);
    expect(s.totalPlays).toBe(140);
    expect(s.byStyle.map((g) => [g.key, g.n, g.avgPlays])).toEqual([["vote", 1, 100], ["vitrine", 2, 20]]);
    expect(s.byLang.map((g) => g.key).sort()).toEqual(["en", "fr"]);
    expect(s.top[0].queueId).toBe(3);
  });

  it(`flags a group under ${LOW_SAMPLE} Reels as low-sample, so a 2-Reel average never reads as a finding`, () => {
    const s = summarizeReels([row({ queueId: 1 }), row({ queueId: 2 })]);
    expect(s.byStyle[0]).toMatchObject({ n: 2, lowSample: true });
    const big = summarizeReels(Array.from({ length: LOW_SAMPLE }, (_, i) => row({ queueId: i })));
    expect(big.byStyle[0].lowSample).toBe(false);
  });

  it("uses the median as well as the mean (one viral Reel must not hide a flat style)", () => {
    const s = summarizeReels([10, 10, 10, 10, 1000].map((p, i) => row({ queueId: i, plays: p })));
    expect(s.byStyle[0].medianPlays).toBe(10);
    expect(s.byStyle[0].avgPlays).toBe(208);
  });

  it("averages watch time only over Reels that reported one, in seconds", () => {
    const s = summarizeReels([row({ avgWatchMs: 4000 }), row({ queueId: 2, avgWatchMs: null }), row({ queueId: 3, avgWatchMs: 6000 })]);
    expect(s.byStyle[0].avgWatchS).toBe(5);
    expect(summarizeReels([row({ avgWatchMs: null })]).byStyle[0].avgWatchS).toBeNull();
  });

  it(`keeps Reels younger than ${MATURE_HOURS} h out of every comparison — but not out of the totals`, () => {
    const old = row({ queueId: 1, style: "vitrine", plays: 100, ageHours: 200 });
    const young = row({ queueId: 2, style: "vote", plays: 3, ageHours: 5 });
    const s = summarizeReels([old, young]);
    expect(s.measured).toBe(2);
    expect(s.matureCount).toBe(1);
    expect(s.totalPlays).toBe(103);
    expect(s.byStyle.map((g) => g.key)).toEqual(["vitrine"]);
    expect(s.bySlot).toHaveLength(1);
    expect(s.top.map((r) => r.queueId)).toEqual([1]);
    expect(summarizeReels([young]).byStyle).toEqual([]);
  });

  it("handles no data at all", () => {
    expect(summarizeReels([])).toMatchObject({ measured: 0, totalPlays: 0, byStyle: [], top: [], bottom: [], lastMeasuredOn: null });
  });

  it("only lists a 'worst' set once there are more than five Reels, and reports the latest measurement date", () => {
    expect(summarizeReels([row()]).bottom).toEqual([]);
    const rows = Array.from({ length: 8 }, (_, i) => row({ queueId: i, plays: i, measuredOn: i === 3 ? "2026-10-09" : "2026-10-07" }));
    const s = summarizeReels(rows);
    expect(s.bottom.map((r) => r.plays)).toEqual([0, 1, 2, 3, 4]);
    expect(s.lastMeasuredOn).toBe("2026-10-09");
  });
});

describe("styleLabelOf", () => {
  it("knows the original styles, the Hormozi ones and the batch types — and falls back to the raw key", () => {
    expect(styleLabelOf("vitrine")).toBe("Vitrine");
    expect(styleLabelOf("aventure")).toBe("Les aventures d’Ameublo");
    expect(styleLabelOf("aventure", "en")).toBe("Furni’s adventures");
    expect(styleLabelOf("vote")).toBe("Le vote d’Ameublo");
    expect(styleLabelOf("assembly")).toBe("Montage (lot)");
    expect(styleLabelOf("ugc_video")).toBe("Vidéo client (UGC)");
    expect(styleLabelOf("mystery")).toBe("mystery");
    expect(styleLabelOf(null)).toBe("—");
  });
});
