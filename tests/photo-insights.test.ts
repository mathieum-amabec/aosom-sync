import { describe, it, expect, vi } from "vitest";
import { insightValues, parseFacebookPhoto, parseInstagramPhoto, summarizePhotos, formatLabelOf, type PhotoResultRow } from "@/lib/photo-insights";

vi.mock("@/lib/facebook-client", () => ({ facebookBrandCreds: () => ({ pageId: "1", token: "fb-token", label: "x" }) }));
vi.mock("@/lib/instagram-client", () => ({ instagramBrandCreds: () => ({ igUserId: "2", token: "ig-token", label: "y" }) }));
import { fetchFacebookPhotoInsights, fetchInstagramPhotoInsights } from "@/lib/photo-insights-client";

const ins = (o: Record<string, number>) => ({ data: Object.entries(o).map(([name, value]) => ({ name, values: [{ value }] })) });

describe("parsing", () => {
  it("reads current and legacy Facebook metric names plus the post's own counters", () => {
    const fields = { reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 } };
    expect(parseFacebookPhoto(fields, ins({ post_media_view: 400, post_total_media_view_unique: 300, post_clicks: 7 }))).toEqual({
      views: 400, reach: 300, reactions: 9, comments: 2, shares: 1, clicks: 7, saves: null,
    });
    expect(parseFacebookPhoto(fields, ins({ post_impressions: 250, post_impressions_unique: 180 }))).toMatchObject({ views: 250, reach: 180 });
  });
  it("a post nobody shared has 0 shares, but an unreadable post has none known", () => {
    expect(parseFacebookPhoto({ reactions: { summary: { total_count: 1 } } }, ins({})).shares).toBe(0);
    expect(parseFacebookPhoto(null, ins({})).shares).toBeNull();
  });
  it("tolerates retired metrics: a missing one is null, never a crash", () => {
    expect(parseFacebookPhoto({ reactions: { summary: { total_count: 3 } } }, { data: [] })).toMatchObject({ views: null, reach: null, reactions: 3 });
    expect(insightValues(undefined)).toEqual({});
    expect(insightValues({ data: [{ name: "views", total_value: { value: 12 } }] })).toEqual({ views: 12 });
  });
  it("reads Instagram media insights", () => {
    expect(parseInstagramPhoto(ins({ views: 90, reach: 70, likes: 8, comments: 1, shares: 2, saved: 3 }))).toEqual({
      views: 90, reach: 70, reactions: 8, comments: 1, shares: 2, clicks: null, saves: 3,
    });
  });
});

const row = (o: Partial<PhotoResultRow>): PhotoResultRow => ({
  queueId: 1, format: "baisses", publishedAt: "2026-10-10 14:00:00", ageHours: 72, measuredOn: "2026-10-13",
  views: 100, reach: 80, reactions: 4, comments: 1, shares: 0, clicks: null, saves: null, ...o,
});

describe("summarizePhotos", () => {
  it("compares formats on mature photos only, but totals every photo", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row({ queueId: i, format: "baisses", views: 200 })),
      ...Array.from({ length: 5 }, (_, i) => row({ queueId: 10 + i, format: "piece", views: 100 })),
      row({ queueId: 99, format: "piece", views: 5000, ageHours: 6 }), // too young: counted in totals, never compared
    ];
    const s = summarizePhotos(rows);
    expect(s.measured).toBe(11);
    expect(s.matureCount).toBe(10);
    expect(s.totalViews).toBe(1000 + 500 + 5000);
    expect(s.byFormat[0]).toMatchObject({ key: "baisses", n: 5, avgViews: 200, lowSample: false });
    expect(s.byFormat[1]).toMatchObject({ key: "piece", n: 5, avgViews: 100 });
  });
  it("flags a format with fewer than 5 photos as a low sample", () => {
    expect(summarizePhotos([row({}), row({ queueId: 2 })]).byFormat[0].lowSample).toBe(true);
  });
  it("falls back to reach when a photo has no views figure", () => {
    expect(summarizePhotos([row({ views: null, reach: 55 })]).totalViews).toBe(55);
  });
  it("names formats in French", () => {
    expect(formatLabelOf("top-ventes")).toBe("Les plus populaires");
    expect(formatLabelOf("inconnu")).toBe("inconnu");
  });
});

describe("network readers", () => {
  const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

  it("reads Facebook counters and insights in two calls", async () => {
    const f = vi.fn(async (url: string) =>
      json(String(url).includes("/insights") ? ins({ post_media_view: 321 }) : { reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 0 } } }),
    );
    const m = await fetchFacebookPhotoInsights("123_456", "ameublo", { fetchImpl: f as unknown as typeof fetch });
    expect(m).toMatchObject({ views: 321, reactions: 5, comments: 0 });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("keeps the metrics Meta still has when it rejects one (code 100)", async () => {
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/insights?metric=post_media_view,")) return json({ error: { code: 100, message: "metric retired" } }, false);
      if (u.includes("/insights?metric=post_impressions_unique")) return json(ins({ post_impressions_unique: 40 }));
      if (u.includes("/insights")) return json({ error: { code: 100, message: "metric retired" } }, false);
      return json({ reactions: { summary: { total_count: 2 } } });
    });
    const m = await fetchFacebookPhotoInsights("1_2", "furnish", { fetchImpl: f as unknown as typeof fetch });
    expect(m).toMatchObject({ reach: 40, views: null, reactions: 2 });
  });
  it("throws with Meta's own message when nothing came back", async () => {
    const f = vi.fn(async () => json({ error: { code: 190, message: "token expired" } }, false));
    await expect(fetchFacebookPhotoInsights("1_2", "ameublo", { fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/token expired/);
  });
  it("reads Instagram media insights", async () => {
    const f = vi.fn(async () => json(ins({ views: 12, reach: 9, likes: 3 })));
    expect(await fetchInstagramPhotoInsights("999", "ameublo", { fetchImpl: f as unknown as typeof fetch })).toMatchObject({ views: 12, reach: 9, reactions: 3 });
  });
});
