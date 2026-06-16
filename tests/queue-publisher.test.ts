import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/facebook-client", () => ({
  publishText: vi.fn().mockResolvedValue({ id: "fb-txt", postId: "fb-txt" }),
  publishWithImage: vi.fn().mockResolvedValue({ id: "fb-img", postId: "fb-img" }),
  publishWithImages: vi.fn().mockResolvedValue({ id: "fb-alb", postId: "fb-alb" }),
  publishVideo: vi.fn().mockResolvedValue({ id: "fb-vid", postId: "fb-vid" }),
}));
vi.mock("@/lib/instagram-client", () => ({
  publishPhoto: vi.fn().mockResolvedValue({ id: "ig-photo", creationId: "c1" }),
  publishReel: vi.fn().mockResolvedValue({ id: "ig-reel", creationId: "c2" }),
}));
vi.mock("@/lib/shopify-blog", () => ({
  createBlogArticle: vi.fn().mockResolvedValue({ articleId: "blog-1", blogId: 7, handle: "h", adminUrl: "u" }),
}));
vi.mock("@/lib/database", () => ({
  getNextPending: vi.fn(),
  claimQueueItem: vi.fn(),
  markPublished: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
}));

import {
  publishQueueItem,
  drainPublisherQueue,
  parseSocialPayload,
  parseBlogPayload,
} from "@/lib/queue-publisher";
import {
  publishText,
  publishWithImage,
  publishWithImages,
  publishVideo,
} from "@/lib/facebook-client";
import { publishPhoto, publishReel } from "@/lib/instagram-client";
import { createBlogArticle } from "@/lib/shopify-blog";
import { getNextPending, claimQueueItem, markPublished, markFailed } from "@/lib/database";

function item(overrides: Partial<{ id: number; platform: string; payload: unknown; contentType: string }>) {
  const payload = overrides.payload;
  return {
    id: overrides.id ?? 1,
    contentType: (overrides.contentType ?? "social") as never,
    contentId: "src-1",
    platform: (overrides.platform ?? "facebook") as never,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
    scheduledAt: "2026-06-15 15:00:00",
    status: "pending" as never,
    error: null,
    createdAt: "2026-06-15 14:00:00",
    publishedAt: null,
  };
}

const social = (extra: Record<string, unknown> = {}) => ({ caption: "Bonjour", brand: "ameublo", ...extra });

beforeEach(() => vi.clearAllMocks());

describe("publishQueueItem — facebook media selection", () => {
  it("video → publishVideo", async () => {
    const r = await publishQueueItem(item({ platform: "facebook", payload: social({ videoUrl: "https://cdn/v.mp4" }) }));
    expect(publishVideo).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "https://cdn/v.mp4", brand: "ameublo", caption: "Bonjour" }));
    expect(r.postId).toBe("fb-vid");
  });

  it("2+ images → publishWithImages (album)", async () => {
    await publishQueueItem(item({ platform: "facebook", payload: social({ imageUrls: ["a.jpg", "b.jpg"] }) }));
    expect(publishWithImages).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: ["a.jpg", "b.jpg"] }));
    expect(publishWithImage).not.toHaveBeenCalled();
  });

  it("single image → publishWithImage", async () => {
    await publishQueueItem(item({ platform: "facebook", payload: social({ imageUrl: "a.jpg" }) }));
    expect(publishWithImage).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "a.jpg" }));
  });

  it("no media → publishText (with link)", async () => {
    await publishQueueItem(item({ platform: "facebook", payload: social({ link: "https://shop/x" }) }));
    expect(publishText).toHaveBeenCalledWith(expect.objectContaining({ message: "Bonjour", link: "https://shop/x" }));
  });
});

describe("publishQueueItem — instagram", () => {
  it("reel video → publishReel", async () => {
    const r = await publishQueueItem(item({ platform: "instagram", payload: social({ reelsVideoUrl: "r.mp4" }) }));
    expect(publishReel).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "r.mp4" }));
    expect(r.postId).toBe("ig-reel");
  });

  it("image → publishPhoto", async () => {
    const r = await publishQueueItem(item({ platform: "instagram", payload: social({ imageUrl: "a.jpg" }) }));
    expect(publishPhoto).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "a.jpg" }));
    expect(r.postId).toBe("ig-photo");
  });

  it("no media → throws (IG requires media)", async () => {
    await expect(publishQueueItem(item({ platform: "instagram", payload: social() }))).rejects.toThrow(/requires an image or video/i);
    expect(publishPhoto).not.toHaveBeenCalled();
  });
});

describe("publishQueueItem — both", () => {
  it("publishes to FB and IG, returns a postId", async () => {
    const r = await publishQueueItem(item({ platform: "both", payload: social({ imageUrl: "a.jpg" }) }));
    expect(publishWithImage).toHaveBeenCalled();
    expect(publishPhoto).toHaveBeenCalled();
    expect(r.postId).toBe("fb-img");
    expect(r.partialError).toBeUndefined();
  });

  it("partial failure (IG fails) still resolves with partialError", async () => {
    vi.mocked(publishPhoto).mockRejectedValueOnce(new Error("IG down"));
    const r = await publishQueueItem(item({ platform: "both", payload: social({ imageUrl: "a.jpg" }) }));
    expect(r.postId).toBe("fb-img");
    expect(r.partialError).toMatch(/instagram: IG down/);
  });

  it("total failure (both fail) throws with combined error", async () => {
    vi.mocked(publishWithImage).mockRejectedValueOnce(new Error("FB down"));
    vi.mocked(publishPhoto).mockRejectedValueOnce(new Error("IG down"));
    await expect(publishQueueItem(item({ platform: "both", payload: social({ imageUrl: "a.jpg" }) }))).rejects.toThrow(/facebook: FB down \| instagram: IG down/);
  });
});

describe("publishQueueItem — shopify_blog + validation", () => {
  it("dispatches to createBlogArticle", async () => {
    const r = await publishQueueItem(item({
      platform: "shopify_blog",
      contentType: "blog",
      payload: { title: "T", bodyHtml: "<p>x</p>", lang: "fr" },
    }));
    expect(createBlogArticle).toHaveBeenCalledWith(expect.objectContaining({ title: "T", lang: "fr" }));
    expect(r.postId).toBe("blog-1");
  });

  it("invalid JSON payload throws", async () => {
    await expect(publishQueueItem(item({ platform: "facebook", payload: "{not json" }))).rejects.toThrow(/not valid JSON/i);
  });

  it("missing caption throws", async () => {
    await expect(publishQueueItem(item({ platform: "facebook", payload: { brand: "ameublo" } }))).rejects.toThrow(/caption is required/i);
  });

  it("unsupported platform throws", async () => {
    await expect(publishQueueItem(item({ platform: "tiktok", payload: social() }))).rejects.toThrow(/Unsupported platform/i);
  });

  it("rejects a content_type/platform mismatch (blog content on a social platform)", async () => {
    await expect(
      publishQueueItem(item({ platform: "facebook", contentType: "blog", payload: social({ imageUrl: "a.jpg" }) })),
    ).rejects.toThrow(/does not match platform/i);
  });

  it("rejects a content_type/platform mismatch (social content on shopify_blog)", async () => {
    await expect(
      publishQueueItem(item({ platform: "shopify_blog", contentType: "social", payload: { title: "T", bodyHtml: "x", lang: "fr" } })),
    ).rejects.toThrow(/does not match platform/i);
  });
});

describe("parse helpers", () => {
  it("parseSocialPayload rejects a bad brand", () => {
    expect(() => parseSocialPayload({ caption: "x", brand: "twitter" })).toThrow(/brand must be/i);
  });
  it("parseSocialPayload drops empty imageUrls down to undefined", () => {
    expect(parseSocialPayload({ caption: "x", brand: "ameublo", imageUrls: ["", "  "] }).imageUrls).toBeUndefined();
  });
  it("parseBlogPayload requires title/bodyHtml/lang", () => {
    expect(() => parseBlogPayload({ bodyHtml: "x", lang: "fr" })).toThrow(/title is required/i);
    expect(() => parseBlogPayload({ title: "T", lang: "fr" })).toThrow(/bodyHtml is required/i);
    expect(() => parseBlogPayload({ title: "T", bodyHtml: "x", lang: "es" })).toThrow(/lang must be/i);
  });
});

describe("drainPublisherQueue", () => {
  const noSleep = vi.fn().mockResolvedValue(undefined);

  it("claims, publishes, and marks each pending item; rate-limits between (not before first)", async () => {
    vi.mocked(getNextPending).mockResolvedValue([
      item({ id: 1, platform: "facebook", payload: social({ imageUrl: "a.jpg" }) }),
      item({ id: 2, platform: "instagram", payload: social({ imageUrl: "b.jpg" }) }),
    ] as never);
    vi.mocked(claimQueueItem).mockResolvedValue(true);

    const res = await drainPublisherQueue({ sleep: noSleep });

    expect(getNextPending).toHaveBeenCalledWith(5);
    expect(claimQueueItem).toHaveBeenCalledTimes(2);
    expect(markPublished).toHaveBeenCalledTimes(2);
    expect(markFailed).not.toHaveBeenCalled();
    expect(noSleep).toHaveBeenCalledTimes(1); // between the 2 posts, not before the first
    expect(noSleep).toHaveBeenCalledWith(2000);
    expect(res).toMatchObject({ processed: 2, published: 2, failed: 0, skipped: 0 });
  });

  it("skips an item another instance already claimed (no publish, no mark)", async () => {
    vi.mocked(getNextPending).mockResolvedValue([item({ id: 1, payload: social({ imageUrl: "a.jpg" }) })] as never);
    vi.mocked(claimQueueItem).mockResolvedValue(false);

    const res = await drainPublisherQueue({ sleep: noSleep });

    expect(markPublished).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(publishWithImage).not.toHaveBeenCalled();
    expect(res).toMatchObject({ processed: 1, published: 0, skipped: 1 });
  });

  it("marks an item failed when publishing throws", async () => {
    vi.mocked(getNextPending).mockResolvedValue([item({ id: 9, platform: "facebook", payload: social({ imageUrl: "a.jpg" }) })] as never);
    vi.mocked(claimQueueItem).mockResolvedValue(true);
    vi.mocked(publishWithImage).mockRejectedValueOnce(new Error("boom"));

    const res = await drainPublisherQueue({ sleep: noSleep });

    expect(markFailed).toHaveBeenCalledWith(9, "boom");
    expect(markPublished).not.toHaveBeenCalled();
    expect(res).toMatchObject({ processed: 1, published: 0, failed: 1 });
  });

  it("honors a custom limit", async () => {
    vi.mocked(getNextPending).mockResolvedValue([] as never);
    await drainPublisherQueue({ limit: 3, sleep: noSleep });
    expect(getNextPending).toHaveBeenCalledWith(3);
  });

  it("defers remaining items (leaves them pending) once the time budget is exceeded", async () => {
    vi.mocked(getNextPending).mockResolvedValue([
      item({ id: 1, platform: "facebook", payload: social({ imageUrl: "a.jpg" }) }),
      item({ id: 2, platform: "facebook", payload: social({ imageUrl: "b.jpg" }) }),
      item({ id: 3, platform: "facebook", payload: social({ imageUrl: "c.jpg" }) }),
    ] as never);
    vi.mocked(claimQueueItem).mockResolvedValue(true);
    // Clock: 0 for item 1 (under budget), then jumps past budget for items 2 and 3.
    const times = [0, 0, 100_000, 100_000];
    let t = 0;
    const now = () => times[Math.min(t++, times.length - 1)];

    const res = await drainPublisherQueue({ budgetMs: 50_000, sleep: noSleep, now });

    expect(claimQueueItem).toHaveBeenCalledTimes(1); // only item 1 claimed
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ processed: 1, published: 1, deferred: 2 });
  });
});
