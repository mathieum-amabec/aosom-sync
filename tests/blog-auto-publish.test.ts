import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the judge's Claude client, the DB cap helpers, and the Shopify publish call so the
// gate logic is tested in isolation (no network, no real Claude/Shopify).
const createMessage = vi.fn();
vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: createMessage } }),
}));
vi.mock("@/lib/database", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  reserveBlogPublishSlot: vi.fn().mockResolvedValue(true),
  releaseBlogPublishSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/publication-scheduler", () => ({
  parseBlogSchedule: vi.fn(() => ({ enabled: true, posts_per_week: 2, preferred_days: ["tue", "thu"], preferred_time: "10:00" })),
}));
vi.mock("@/lib/shopify-blog", () => ({
  publishBlogArticle: vi.fn().mockResolvedValue(undefined),
}));

import { maybeAutoPublish, scoreArticle } from "@/lib/blog-auto-publish";
import { publishBlogArticle } from "@/lib/shopify-blog";
import { reserveBlogPublishSlot, releaseBlogPublishSlot } from "@/lib/database";
import { parseBlogSchedule } from "@/lib/publication-scheduler";

const article = { title: "T", bodyHtml: "<p>x</p>", metaDescription: "m", tags: ["a", "b"] };

function judgeReturns(score: number, reasons = "ok") {
  createMessage.mockResolvedValueOnce({
    content: [{ type: "text", text: JSON.stringify({ score, reasons }) }],
  });
}

const baseParams = {
  autoPublish: true as boolean,
  lang: "fr" as const,
  season: "all" as const,
  article,
  blogId: 90302349417,
  articleId: "555",
  now: new Date("2026-07-15T12:00:00Z"), // summer
};

beforeEach(() => vi.clearAllMocks());

describe("scoreArticle", () => {
  it("parses and clamps the judge score", async () => {
    createMessage.mockResolvedValueOnce({ content: [{ type: "text", text: '{"score": 140, "reasons": "great"}' }] });
    expect((await scoreArticle(article, "fr")).score).toBe(100);
    createMessage.mockResolvedValueOnce({ content: [{ type: "text", text: '```json\n{"score": 73, "reasons": "ok"}\n```' }] });
    expect((await scoreArticle(article, "en")).score).toBe(73);
  });

  it("throws on a non-numeric / missing score", async () => {
    createMessage.mockResolvedValueOnce({ content: [{ type: "text", text: '{"reasons": "no score"}' }] });
    await expect(scoreArticle(article, "fr")).rejects.toThrow(/numeric score/i);
  });

  it("throws on empty content", async () => {
    createMessage.mockResolvedValueOnce({ content: [] });
    await expect(scoreArticle(article, "fr")).rejects.toThrow(/empty or non-text/i);
  });
});

describe("maybeAutoPublish — gate", () => {
  it("does nothing when autoPublish is false (manual call stays draft)", async () => {
    const r = await maybeAutoPublish({ ...baseParams, autoPublish: false });
    expect(r).toEqual({ published: false, score: null, publishReason: "auto-publish not requested" });
    expect(createMessage).not.toHaveBeenCalled();
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("publishes when score >= 80, in season, and under cap", async () => {
    judgeReturns(88);
    const r = await maybeAutoPublish(baseParams);
    expect(r.published).toBe(true);
    expect(r.score).toBe(88);
    expect(reserveBlogPublishSlot).toHaveBeenCalledWith("2026-W29", 2);
    expect(publishBlogArticle).toHaveBeenCalledWith(90302349417, "555");
  });

  it("holds as draft when score is below threshold (no publish, no cap consumed)", async () => {
    judgeReturns(79);
    const r = await maybeAutoPublish(baseParams);
    expect(r.published).toBe(false);
    expect(r.publishReason).toMatch(/79 < 80/);
    expect(reserveBlogPublishSlot).not.toHaveBeenCalled();
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("holds a high-scoring but out-of-season topic", async () => {
    judgeReturns(95);
    // winter topic in July → out of season
    const r = await maybeAutoPublish({ ...baseParams, season: "winter" });
    expect(r.published).toBe(false);
    expect(r.publishReason).toMatch(/out of season \(winter\)/);
    expect(reserveBlogPublishSlot).not.toHaveBeenCalled();
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("holds when the weekly cap is reached (reserve returns false)", async () => {
    judgeReturns(90);
    vi.mocked(reserveBlogPublishSlot).mockResolvedValueOnce(false);
    const r = await maybeAutoPublish(baseParams);
    expect(r.published).toBe(false);
    expect(r.publishReason).toMatch(/weekly cap reached \(2\)/);
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("releases the reserved slot if the Shopify publish fails (stays draft)", async () => {
    judgeReturns(90);
    vi.mocked(publishBlogArticle).mockRejectedValueOnce(new Error("Shopify 422"));
    const r = await maybeAutoPublish(baseParams);
    expect(r.published).toBe(false);
    expect(r.publishReason).toMatch(/publish failed/i);
    expect(releaseBlogPublishSlot).toHaveBeenCalledWith("2026-W29");
  });

  it("keeps the article as draft when scoring throws (judge failure)", async () => {
    createMessage.mockRejectedValueOnce(new Error("Claude 529"));
    const r = await maybeAutoPublish(baseParams);
    expect(r).toEqual({ published: false, score: null, publishReason: "quality scoring failed" });
    expect(reserveBlogPublishSlot).not.toHaveBeenCalled();
  });

  it("respects posts_per_week from blog_schedule as the cap", async () => {
    judgeReturns(90);
    vi.mocked(parseBlogSchedule).mockReturnValueOnce({ enabled: true, posts_per_week: 5, preferred_days: ["tue"], preferred_time: "10:00" });
    await maybeAutoPublish(baseParams);
    expect(reserveBlogPublishSlot).toHaveBeenCalledWith("2026-W29", 5);
  });

  it("does not publish when blog_schedule.enabled is false (master switch)", async () => {
    vi.mocked(parseBlogSchedule).mockReturnValueOnce({ enabled: false, posts_per_week: 2, preferred_days: ["tue"], preferred_time: "10:00" });
    const r = await maybeAutoPublish(baseParams);
    expect(r).toEqual({ published: false, score: null, publishReason: "auto-publish disabled (blog_schedule)" });
    expect(createMessage).not.toHaveBeenCalled(); // gated before the judge call
    expect(reserveBlogPublishSlot).not.toHaveBeenCalled();
  });
});
