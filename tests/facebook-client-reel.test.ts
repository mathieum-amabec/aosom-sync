import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Provide fake env so config.ts doesn't throw during import.
process.env.FACEBOOK_AMEUBLO_PAGE_ID = "TEST_PAGE_ID";
process.env.FACEBOOK_AMEUBLO_PAGE_TOKEN = "TEST_PAGE_TOKEN";
process.env.FACEBOOK_FURNISH_PAGE_ID = "TEST_FURNISH_ID";
process.env.FACEBOOK_FURNISH_PAGE_TOKEN = "TEST_FURNISH_TOKEN";

import { publishFacebookReel } from "@/lib/facebook-client";

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

describe("publishFacebookReel — /video_reels resumable flow", () => {
  let calls: FakeCall[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const headers = (init?.headers as Record<string, string>) || {};
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url: urlStr, method: init?.method || "GET", headers, body });

      if (urlStr.endsWith("/video_reels") && body?.upload_phase === "start") {
        return new Response(
          JSON.stringify({ video_id: "reel_99", upload_url: "https://rupload.facebook.com/video-upload/v21.0/reel_99" }),
          { status: 200 },
        );
      }
      if (urlStr.includes("rupload.facebook.com")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (urlStr.endsWith("/video_reels") && body?.upload_phase === "finish") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("runs start → upload (file_url) → finish and returns the reel id", async () => {
    const res = await publishFacebookReel({
      caption: "Nouveau produit",
      videoUrl: "https://cdn.example.com/reel.mp4",
      pageId: "PAGE_42",
      token: "TOK",
      label: "Ameublo Direct",
    });
    expect(res).toEqual({ id: "reel_99", postId: "reel_99" });

    expect(calls).toHaveLength(3);
    // start
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/PAGE_42/video_reels");
    expect(calls[0].body?.upload_phase).toBe("start");
    // upload — hosted file_url header, OAuth auth
    expect(calls[1].url).toContain("rupload.facebook.com");
    expect(calls[1].headers.file_url).toBe("https://cdn.example.com/reel.mp4");
    expect(calls[1].headers.Authorization).toBe("OAuth TOK");
    // finish — publishes with the caption
    expect(calls[2].body?.upload_phase).toBe("finish");
    expect(calls[2].body?.video_id).toBe("reel_99");
    expect(calls[2].body?.video_state).toBe("PUBLISHED");
    expect(calls[2].body?.description).toBe("Nouveau produit");
  });

  it("throws when the start phase errors", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad page" } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      publishFacebookReel({ caption: "x", videoUrl: "https://cdn/x.mp4", pageId: "P", token: "T" }),
    ).rejects.toThrow(/reel start/);
  });
});
