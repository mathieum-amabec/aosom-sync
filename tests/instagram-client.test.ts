import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { instagramAmeubloAccountId: "IG_123", facebookAmeubloPageToken: "PAGE_TOKEN" },
  META: { GRAPH_API_URL: "https://graph.facebook.com/v21.0" },
}));

import { publishReel, publishCarousel, publishPhoto } from "@/lib/instagram-client";

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("publishPhoto (Instagram photo, raw URL)", () => {
  it("creates a container with the RAW image_url → publishes (no watermark/Blob)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/IG_123/media_publish")) return Promise.resolve(json({ id: "media1" }));
      if (url.includes("/IG_123/media")) return Promise.resolve(json({ id: "creation1" }));
      return Promise.resolve(json({}));
    });

    const res = await publishPhoto({ caption: "New sofa", imageUrl: "https://cdn/a.jpg", brand: "ameublo" });
    expect(res).toEqual({ id: "media1", creationId: "creation1" });

    // The container is created with the raw source URL — NOT a hosted/watermarked blob.
    const createCall = fetchMock.mock.calls.find((c) => c[0].includes("/IG_123/media") && c[1].method === "POST");
    const body = JSON.parse(createCall![1].body);
    expect(body.image_url).toBe("https://cdn/a.jpg");
    expect(body.caption).toBe("New sofa");
  });

  it("surfaces a publish-step Graph error", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/IG_123/media_publish")) return Promise.resolve(json({ error: { message: "publish blew up" } }, 400));
      if (url.includes("/IG_123/media")) return Promise.resolve(json({ id: "creation1" }));
      return Promise.resolve(json({}));
    });

    await expect(
      publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" }),
    ).rejects.toThrow(/publish blew up/);
  });

  describe("readiness and retry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const publishCalls = () => fetchMock.mock.calls.filter((c) => c[0].includes("media_publish"));

    it("waits until the container is FINISHED before publishing", async () => {
      let polls = 0;
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("media_publish")) return Promise.resolve(json({ id: "media1" }));
        if (url.includes("fields=status_code")) return Promise.resolve(json({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" }));
        return Promise.resolve(json({ id: "creation1" }));
      });
      const p = publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ id: "media1", creationId: "creation1" });
      expect(polls).toBe(3);
    });

    it("does not publish a container Instagram marked ERROR, and says why", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("fields=status_code")) return Promise.resolve(json({ status_code: "ERROR", status: "Error: Image could not be fetched" }));
        return Promise.resolve(json({ id: "creation1" }));
      });
      const p = publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" });
      const assertion = expect(p).rejects.toThrow(/photo container ERROR — Error: Image could not be fetched/);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(publishCalls()).toHaveLength(0);
    });

    it("gives up after 30 s when the container never gets ready", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("fields=status_code")) return Promise.resolve(json({ status_code: "IN_PROGRESS" }));
        return Promise.resolve(json({ id: "creation1" }));
      });
      const p = publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" });
      const assertion = expect(p).rejects.toThrow(/photo container not ready after 30s/);
      await vi.advanceTimersByTimeAsync(35_000);
      await assertion;
      expect(publishCalls()).toHaveLength(0);
    });

    it("retries the publish step when Meta says the media is not ready yet", async () => {
      let attempts = 0;
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("media_publish")) {
          return Promise.resolve(++attempts === 1 ? json({ error: { message: "Media ID is not available", code: 9007 } }, 400) : json({ id: "media1" }));
        }
        if (url.includes("fields=status_code")) return Promise.resolve(json({ status_code: "FINISHED" }));
        return Promise.resolve(json({ id: "creation1" }));
      });
      const p = publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" });
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(p).resolves.toMatchObject({ id: "media1" });
      expect(publishCalls()).toHaveLength(2);
    });

    it("stops after 3 attempts and reports how many it made", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("media_publish")) return Promise.resolve(json({ error: { message: "The media is not ready for publishing", code: 9007 } }, 400));
        if (url.includes("fields=status_code")) return Promise.resolve(json({ status_code: "FINISHED" }));
        return Promise.resolve(json({ id: "creation1" }));
      });
      const p = publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" });
      const assertion = expect(p).rejects.toThrow(/not ready for publishing.*\[after 3 attempts\]/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(publishCalls()).toHaveLength(3);
    });

    it("never retries a refusal (permission, policy)", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("media_publish")) return Promise.resolve(json({ error: { message: "Application does not have permission for this action", code: 10 } }, 400));
        if (url.includes("fields=status_code")) return Promise.resolve(json({ status_code: "FINISHED" }));
        return Promise.resolve(json({ id: "creation1" }));
      });
      await expect(publishPhoto({ caption: "x", imageUrl: "https://cdn/a.jpg", brand: "ameublo" })).rejects.toThrow(/does not have permission/);
      expect(publishCalls()).toHaveLength(1);
    });

    it("a carousel waits for every child and for the parent before publishing", async () => {
      const polled: string[] = [];
      let n = 0;
      fetchMock.mockImplementation((url: string, opts: { body?: string } = {}) => {
        if (url.includes("media_publish")) return Promise.resolve(json({ id: "media1" }));
        if (url.includes("fields=status_code")) {
          polled.push(url.split("?")[0].split("/").pop()!);
          return Promise.resolve(json({ status_code: "FINISHED" }));
        }
        const body = JSON.parse(opts.body!);
        return Promise.resolve(json({ id: body.media_type === "CAROUSEL" ? "parent" : `child${++n}` }));
      });
      const p = publishCarousel({ caption: "x", imageUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"], brand: "ameublo" });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(p).resolves.toMatchObject({ id: "media1" });
      expect(polled).toEqual(["child1", "child2", "parent"]);
    });
  });
});

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

describe("publishCarousel (Instagram carousel, raw URLs)", () => {
  it("creates child + CAROUSEL containers with the raw image URLs, then publishes", async () => {
    let childCount = 0;
    fetchMock.mockImplementation((url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes("/IG_123/media_publish")) return Promise.resolve(json({ id: "media1" }));
      if (url.includes("/IG_123/media")) {
        const body = JSON.parse(opts.body!);
        if (body.media_type === "CAROUSEL") return Promise.resolve(json({ id: "carousel1" }));
        childCount++;
        return Promise.resolve(json({ id: `child${childCount}` }));
      }
      return Promise.resolve(json({}));
    });

    const urls = ["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/c.jpg"];
    const res = await publishCarousel({ caption: "Three views", imageUrls: urls, brand: "ameublo" });
    expect(res).toEqual({ id: "media1", creationId: "carousel1" });

    const postCalls = fetchMock.mock.calls.filter(
      (c) => c[0].includes("/IG_123/media") && !c[0].includes("media_publish") && c[1].method === "POST",
    );
    // 3 children + 1 carousel container
    expect(postCalls).toHaveLength(4);

    // Children carry is_carousel_item, the RAW image URL, and NO caption.
    for (let i = 0; i < 3; i++) {
      const childBody = JSON.parse(postCalls[i][1].body);
      expect(childBody.is_carousel_item).toBe(true);
      expect(childBody.image_url).toBe(urls[i]);
      expect(childBody.caption).toBeUndefined();
    }

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
      if (url.includes("/IG_123/media")) {
        const body = JSON.parse(opts.body!);
        if (body.is_carousel_item) return Promise.resolve(json({ error: { message: "bad image_url" } }, 400));
      }
      return Promise.resolve(json({}));
    });
    await expect(
      publishCarousel({ caption: "x", imageUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"], brand: "ameublo" }),
    ).rejects.toThrow(/bad image_url/);
    // never reached the publish step
    expect(fetchMock.mock.calls.some((c) => c[0].includes("media_publish"))).toBe(false);
  });

  it("surfaces a Graph error on the carousel container step", async () => {
    fetchMock.mockImplementation((url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes("/IG_123/media")) {
        const body = JSON.parse(opts.body!);
        if (body.media_type === "CAROUSEL") return Promise.resolve(json({ error: { message: "children invalid" } }, 400));
        return Promise.resolve(json({ id: "child" }));
      }
      return Promise.resolve(json({}));
    });
    await expect(
      publishCarousel({ caption: "x", imageUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"], brand: "ameublo" }),
    ).rejects.toThrow(/children invalid/);
  });
});
