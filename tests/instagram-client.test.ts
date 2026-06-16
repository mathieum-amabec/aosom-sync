import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { instagramAmeubloAccountId: "IG_123", facebookAmeubloPageToken: "PAGE_TOKEN" },
  META: { GRAPH_API_URL: "https://graph.facebook.com/v21.0" },
}));

import { publishReel, publishCarousel } from "@/lib/instagram-client";

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("publishReel (Instagram Reels)", () => {
  it("creates a REELS container, polls until FINISHED, then publishes", async () => {
    let statusPolls = 0;
    fetchMock.mockImplementation((url: string, opts: { method?: string } = {}) => {
      if (url.includes("/IG_123/media_publish")) return Promise.resolve(json({ id: "media1" }));
      if (url.includes("/IG_123/media") && opts.method === "POST") return Promise.resolve(json({ id: "creation1" }));
      if (url.includes("/creation1")) {
        statusPolls++;
        return Promise.resolve(json({ status_code: statusPolls < 2 ? "IN_PROGRESS" : "FINISHED" }));
      }
      return Promise.resolve(json({}));
    });

    const res = await publishReel({
      caption: "New chair",
      videoUrl: "https://cdn/reel.mp4",
      brand: "ameublo",
      poll: { intervalMs: 1, timeoutMs: 1000 },
    });

    expect(res).toEqual({ id: "media1", creationId: "creation1" });
    const createCall = fetchMock.mock.calls.find((c) => c[0].includes("/IG_123/media") && c[1].method === "POST");
    const body = JSON.parse(createCall![1].body);
    expect(body.media_type).toBe("REELS");
    expect(body.video_url).toBe("https://cdn/reel.mp4");
    expect(statusPolls).toBeGreaterThanOrEqual(2); // waited for processing
  });

  it("throws when the container processing errors", async () => {
    fetchMock.mockImplementation((url: string, opts: { method?: string } = {}) => {
      if (url.includes("/IG_123/media") && opts.method === "POST") return Promise.resolve(json({ id: "creation1" }));
      if (url.includes("/creation1")) return Promise.resolve(json({ status_code: "ERROR", status: "transcode failed" }));
      return Promise.resolve(json({}));
    });
    await expect(
      publishReel({ caption: "x", videoUrl: "https://cdn/r.mp4", brand: "ameublo", poll: { intervalMs: 1, timeoutMs: 1000 } }),
    ).rejects.toThrow(/ERROR|transcode/);
  });

  it("surfaces a create-step Graph error", async () => {
    fetchMock.mockImplementation((url: string, opts: { method?: string } = {}) => {
      if (url.includes("/IG_123/media") && opts.method === "POST") return Promise.resolve(json({ error: { message: "bad video_url" } }, 400));
      return Promise.resolve(json({}));
    });
    await expect(
      publishReel({ caption: "x", videoUrl: "bad", brand: "ameublo", poll: { intervalMs: 1, timeoutMs: 100 } }),
    ).rejects.toThrow(/bad video_url/);
  });
});

describe("publishCarousel (Instagram carousel)", () => {
  it("creates a child container per image, then a CAROUSEL container, then publishes", async () => {
    let childCount = 0;
    fetchMock.mockImplementation((url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes("/IG_123/media_publish")) return Promise.resolve(json({ id: "media1" }));
      if (url.includes("/IG_123/media") && opts.method === "POST") {
        const body = JSON.parse(opts.body!);
        if (body.media_type === "CAROUSEL") return Promise.resolve(json({ id: "carousel1" }));
        childCount++;
        return Promise.resolve(json({ id: `child${childCount}` }));
      }
      return Promise.resolve(json({}));
    });

    const res = await publishCarousel({
      caption: "Three views",
      imageUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/c.jpg"],
      brand: "ameublo",
    });

    expect(res).toEqual({ id: "media1", creationId: "carousel1" });

    const postCalls = fetchMock.mock.calls.filter(
      (c) => c[0].includes("/IG_123/media") && !c[0].includes("media_publish") && c[1].method === "POST",
    );
    // 3 children + 1 carousel container
    expect(postCalls).toHaveLength(4);

    // Children carry is_carousel_item and NO caption.
    const childBody = JSON.parse(postCalls[0][1].body);
    expect(childBody.is_carousel_item).toBe(true);
    expect(childBody.image_url).toBe("https://cdn/a.jpg");
    expect(childBody.caption).toBeUndefined();

    // Parent carousel carries children (comma-joined) + the caption.
    const parentBody = JSON.parse(postCalls[3][1].body);
    expect(parentBody.media_type).toBe("CAROUSEL");
    expect(parentBody.children).toBe("child1,child2,child3");
    expect(parentBody.caption).toBe("Three views");
  });

  it.each([1, 11])("rejects an out-of-range image count (%i)", async (n) => {
    await expect(
      publishCarousel({ caption: "x", imageUrls: Array.from({ length: n }, (_, i) => `${i}.jpg`), brand: "ameublo" }),
    ).rejects.toThrow(/2.{0,3}10 images/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts before publishing if a child upload fails", async () => {
    fetchMock.mockImplementation((url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes("/IG_123/media") && opts.method === "POST") {
        const body = JSON.parse(opts.body!);
        if (body.is_carousel_item) return Promise.resolve(json({ error: { message: "bad image_url" } }, 400));
      }
      return Promise.resolve(json({}));
    });
    await expect(
      publishCarousel({ caption: "x", imageUrls: ["a.jpg", "b.jpg"], brand: "ameublo" }),
    ).rejects.toThrow(/bad image_url/);
    // never reached the publish step
    expect(fetchMock.mock.calls.some((c) => c[0].includes("media_publish"))).toBe(false);
  });

  it("surfaces a Graph error on the carousel container step", async () => {
    fetchMock.mockImplementation((url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes("/IG_123/media") && opts.method === "POST") {
        const body = JSON.parse(opts.body!);
        if (body.media_type === "CAROUSEL") return Promise.resolve(json({ error: { message: "children invalid" } }, 400));
        return Promise.resolve(json({ id: "child" }));
      }
      return Promise.resolve(json({}));
    });
    await expect(
      publishCarousel({ caption: "x", imageUrls: ["a.jpg", "b.jpg"], brand: "ameublo" }),
    ).rejects.toThrow(/children invalid/);
  });
});
