import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { instagramAmeubloAccountId: "IG_123", facebookAmeubloPageToken: "PAGE_TOKEN" },
  META: { GRAPH_API_URL: "https://graph.facebook.com/v21.0" },
}));

import { publishReel } from "@/lib/instagram-client";

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
