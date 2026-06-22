import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Provide fake env so config.ts doesn't throw during import.
process.env.FACEBOOK_AMEUBLO_PAGE_ID = "TEST_PAGE_ID";
process.env.FACEBOOK_AMEUBLO_PAGE_TOKEN = "TEST_PAGE_TOKEN";
process.env.FACEBOOK_FURNISH_PAGE_ID = "TEST_FURNISH_ID";
process.env.FACEBOOK_FURNISH_PAGE_TOKEN = "TEST_FURNISH_TOKEN";

// Photos are now branded + binary-uploaded. Stub the watermarker so this test stays
// about the Graph API transport (album flow), not image processing — and so it never
// hits the network. The returned buffer is what should land in the multipart `source`.
vi.mock("@/lib/image-watermark", () => ({
  FOOTER_HEIGHT: 60,
  addWatermarkToImage: vi.fn(async (url: string) => Buffer.from(`WM:${url}`)),
}));

import { publishWithImages } from "@/lib/facebook-client";
import { addWatermarkToImage } from "@/lib/image-watermark";

interface FakeCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** Normalize an init.body into a plain object: FormData fields (with a `source` Blob) or parsed JSON. */
function readBody(init?: RequestInit): Record<string, unknown> {
  if (init?.body instanceof FormData) {
    const fd = init.body;
    const out: Record<string, unknown> = { __form: true };
    for (const key of ["source", "message", "published", "scheduled_publish_time"]) {
      const v = fd.get(key);
      if (v !== null) out[key] = v;
    }
    return out;
  }
  if (typeof init?.body === "string") return JSON.parse(init.body);
  return {};
}

describe("publishWithImages — multi-photo Facebook album (watermarked binary upload)", () => {
  let calls: FakeCall[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    vi.mocked(addWatermarkToImage).mockClear();
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({ url: urlStr, method: init?.method || "GET", body: readBody(init) });
      if (urlStr.includes("/photos")) {
        const id = `photo_${calls.filter((c) => c.url.includes("/photos")).length}`;
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (urlStr.includes("/feed")) {
        return new Response(JSON.stringify({ id: "post_123" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("single photo delegates to publishWithImage (1 /photos call, no /feed)", async () => {
    const result = await publishWithImages({
      caption: "hello",
      imageUrls: ["https://cdn.example.com/a.jpg"],
      brand: "ameublo",
    });
    const photoCalls = calls.filter((c) => c.url.includes("/photos"));
    const feedCalls = calls.filter((c) => c.url.includes("/feed"));
    expect(photoCalls).toHaveLength(1);
    expect(feedCalls).toHaveLength(0);
    // Single-photo path uploads the watermarked binary + message.
    expect(photoCalls[0].body.__form).toBe(true);
    expect(photoCalls[0].body.source).toBeInstanceOf(Blob);
    expect(photoCalls[0].body.message).toBe("hello");
    // The image was watermarked for the right brand before upload.
    expect(addWatermarkToImage).toHaveBeenCalledWith("https://cdn.example.com/a.jpg", "ameublo");
    expect(result.postId).toBeTruthy();
  });

  it("three photos uploads each unpublished, then posts /feed with attached_media array", async () => {
    const urls = [
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.jpg",
      "https://cdn.example.com/c.jpg",
    ];
    const result = await publishWithImages({
      caption: "carousel caption",
      imageUrls: urls,
      brand: "ameublo",
    });

    const photoCalls = calls.filter((c) => c.url.includes("/photos"));
    const feedCalls = calls.filter((c) => c.url.includes("/feed"));

    // Each photo watermarked + uploaded once, unpublished, as binary.
    expect(photoCalls).toHaveLength(3);
    expect(addWatermarkToImage).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(photoCalls[i].body.source).toBeInstanceOf(Blob);
      expect(photoCalls[i].body.published).toBe("false");
      // Single-photo path artifacts must NOT leak into the unpublished uploads.
      expect(photoCalls[i].body.message).toBeUndefined();
      expect(addWatermarkToImage).toHaveBeenNthCalledWith(i + 1, urls[i], "ameublo");
    }

    // /feed gets a single call with attached_media as a JSON array (NOT bracket notation).
    expect(feedCalls).toHaveLength(1);
    const feedBody = feedCalls[0].body;
    expect(feedBody.message).toBe("carousel caption");
    expect(Array.isArray(feedBody.attached_media)).toBe(true);
    expect(feedBody.attached_media).toEqual([
      { media_fbid: "photo_1" },
      { media_fbid: "photo_2" },
      { media_fbid: "photo_3" },
    ]);
    // Must NOT use bracket-notation keys (the /review bug).
    expect(feedBody["attached_media[0]"]).toBeUndefined();
    expect(feedBody["attached_media[1]"]).toBeUndefined();

    expect(result.postId).toBe("post_123");
  });

  it("uses correct Page ID per brand", async () => {
    await publishWithImages({
      caption: "test",
      imageUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
      brand: "furnish",
    });
    // All calls should hit the furnish Page ID, not ameublo.
    for (const call of calls) {
      expect(call.url).toContain("TEST_FURNISH_ID");
      expect(call.url).not.toContain("TEST_PAGE_ID");
    }
  });

  it("throws when all photo uploads fail", async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/photos")) {
        return new Response(JSON.stringify({ error: { message: "Invalid source" } }), { status: 400 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      publishWithImages({
        caption: "test",
        imageUrls: ["https://bad.example.com/1.jpg", "https://bad.example.com/2.jpg"],
        brand: "ameublo",
      })
    ).rejects.toThrow(/all 2 photo uploads failed/);
  });

  it("publishes with partial success (1 of 2 uploads)", async () => {
    let photoCallCount = 0;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({ url: urlStr, method: init?.method || "GET", body: readBody(init) });
      if (urlStr.includes("/photos")) {
        photoCallCount++;
        if (photoCallCount === 1) {
          return new Response(JSON.stringify({ error: { message: "Temporary fail" } }), { status: 500 });
        }
        return new Response(JSON.stringify({ id: `photo_${photoCallCount}` }), { status: 200 });
      }
      if (urlStr.includes("/feed")) {
        return new Response(JSON.stringify({ id: "post_partial" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await publishWithImages({
      caption: "partial test",
      imageUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
      brand: "ameublo",
    });

    const feedCalls = calls.filter((c) => c.url.includes("/feed"));
    expect(feedCalls).toHaveLength(1);
    // Only 1 media_fbid should appear in the album.
    expect(feedCalls[0].body.attached_media).toEqual([{ media_fbid: "photo_2" }]);
    expect(result.postId).toBe("post_partial");
  });
});
