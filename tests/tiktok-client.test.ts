import { describe, it, expect, vi } from "vitest";
import {
  TikTokClient,
  TikTokApiError,
  planChunks,
  chunkRanges,
  tiktokCaptionToPaste,
  TIKTOK_MAX_CHUNK_BYTES,
  TIKTOK_MAX_VIDEO_BYTES,
} from "@/lib/tiktok-client";

const MB = 1024 * 1024;
const VIDEO_URL = "https://blob.example/v.mp4";
const CREDS = { accessToken: "tok" };
const json = (body: unknown, status = 200, extra: Record<string, unknown> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, arrayBuffer: async () => new ArrayBuffer(8), ...extra }) as unknown as Response;
const OK = { code: "ok", message: "", log_id: "L" };

interface Over {
  statuses?: string[];
  init?: unknown;
  put?: number;
  download?: number;
  bytes?: number;
  fail?: string;
}
/** Router for the calls an inbox upload makes; `statuses` answers each poll in turn (the last repeats). */
function router(over: Over = {}) {
  const polls = [...(over.statuses ?? ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"])];
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    if (url === VIDEO_URL) return over.download && over.download >= 400 ? json({}, over.download) : json({}, 200, { arrayBuffer: async () => new ArrayBuffer(over.bytes ?? 1000) });
    if (url.startsWith("https://upload.example")) return json({}, over.put ?? 201);
    if (url.endsWith("/inbox/video/init/")) return json(over.init ?? { data: { publish_id: "v_inbox_file~v2.1", upload_url: "https://upload.example/video?id=1" }, error: OK });
    if (url.endsWith("/status/fetch/")) {
      const status = polls.length > 1 ? polls.shift() : polls[0];
      return json({ data: { status, ...(over.fail ? { fail_reason: over.fail } : {}) }, error: OK });
    }
    if (url.includes("/v2/user/info/")) return json({ data: { user: { open_id: "oid", display_name: "Ameublo Direct", username: "ameublodirect" } }, error: OK });
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}
const client = (r: ReturnType<typeof router>, extra = {}) =>
  new TikTokClient(CREDS, { fetchImpl: r.fetchImpl, sleepImpl: async () => {}, pollIntervalMs: 10, maxWaitMs: 1000, ...extra });

describe("planChunks / chunkRanges", () => {
  it("sends a video up to 64 MB whole, in one chunk — including the under-5 MB case TikTok demands be whole", () => {
    expect(planChunks(3 * MB)).toEqual({ chunkSize: 3 * MB, totalChunkCount: 1 });
    expect(planChunks(9 * MB)).toEqual({ chunkSize: 9 * MB, totalChunkCount: 1 });
    expect(planChunks(TIKTOK_MAX_CHUNK_BYTES)).toEqual({ chunkSize: TIKTOK_MAX_CHUNK_BYTES, totalChunkCount: 1 });
  });
  it("beyond 64 MB uses 64 MB chunks and lets the last one absorb the remainder", () => {
    expect(planChunks(130 * MB)).toEqual({ chunkSize: 64 * MB, totalChunkCount: 2 });
    expect(chunkRanges(130 * MB)).toEqual([
      { start: 0, end: 64 * MB - 1 },
      { start: 64 * MB, end: 130 * MB - 1 },
    ]);
  });
  it("ranges tile the file exactly, with no gap or overlap", () => {
    const size = 200 * MB + 123;
    const r = chunkRanges(size);
    expect(r[0].start).toBe(0);
    expect(r[r.length - 1].end).toBe(size - 1);
    r.slice(1).forEach((c, i) => expect(c.start).toBe(r[i].end + 1));
  });
  it("rejects a size that is not a positive integer", () => {
    expect(() => planChunks(0)).toThrow(/invalid video size/);
    expect(() => planChunks(1.5)).toThrow(/invalid video size/);
  });
});

describe("uploadDraft — dry run", () => {
  it("records the four steps and touches neither the network nor the video", async () => {
    const fetchImpl = vi.fn();
    const c = new TikTokClient(null, { dryRun: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await c.uploadDraft(VIDEO_URL);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(c.plan.map((s) => s.step)).toEqual(["download", "init", "upload", "status"]);
    expect(r.publishId).toBe("dryrun-publish-1");
  });
  it("refuses to be built without credentials unless dryRun is set", () => {
    expect(() => new TikTokClient(null)).toThrow(/credentials are required/);
  });
});

describe("uploadDraft — live", () => {
  it("inits with the exact size, PUTs the bytes with a Content-Range, then polls until the draft is in the inbox", async () => {
    const r = router({ bytes: 4096 });
    const res = await client(r).uploadDraft(VIDEO_URL);
    expect(res).toEqual({ publishId: "v_inbox_file~v2.1", status: "SEND_TO_USER_INBOX" });

    const init = r.calls.find((c) => c.url.endsWith("/inbox/video/init/"))!;
    expect(init.url).toBe("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ source_info: { source: "FILE_UPLOAD", video_size: 4096, chunk_size: 4096, total_chunk_count: 1 } });

    const put = r.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://upload.example/video?id=1");
    expect(put.headers["Content-Range"]).toBe("bytes 0-4095/4096");
    expect(put.headers["Content-Type"]).toBe("video/mp4");
    expect(put.headers.Authorization).toBeUndefined(); // the pre-signed URL carries its own token
    expect((put.body as Uint8Array).byteLength).toBe(4096);

    expect(r.calls.filter((c) => c.url.endsWith("/status/fetch/")).length).toBe(2); // processing, then in the inbox
  });

  it("accepts PUBLISH_COMPLETE as done too", async () => {
    await expect(client(router({ statuses: ["PUBLISH_COMPLETE"] })).uploadDraft(VIDEO_URL)).resolves.toMatchObject({ status: "PUBLISH_COMPLETE" });
  });

  it("waits between polls", async () => {
    const sleepImpl = vi.fn(async () => {});
    await client(router({ statuses: ["PROCESSING_UPLOAD", "PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"] }), { sleepImpl }).uploadDraft(VIDEO_URL);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("fails with TikTok's reason when it cannot process the video", async () => {
    await expect(client(router({ statuses: ["FAILED"], fail: "file_format_check_failed" })).uploadDraft(VIDEO_URL)).rejects.toThrow(/file_format_check_failed/);
  });

  it("gives up after maxWaitMs", async () => {
    await expect(client(router({ statuses: ["PROCESSING_UPLOAD"] }), { maxWaitMs: 0 }).uploadDraft(VIDEO_URL)).rejects.toThrow(/still "PROCESSING_UPLOAD"/);
  });

  it("flattens an init error that TikTok sends with HTTP 200", async () => {
    const init = { data: {}, error: { code: "scope_not_authorized", message: "The user did not authorize the scope required", log_id: "LOG1" } };
    const err = (await client(router({ init })).uploadDraft(VIDEO_URL).catch((e) => e)) as TikTokApiError;
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.code).toBe("scope_not_authorized");
    expect(err.logId).toBe("LOG1");
    expect(err.message).toContain("did not authorize the scope");
  });

  it("explains a failed download, a refused chunk and an unexpected init answer", async () => {
    await expect(client(router({ download: 404 })).uploadDraft(VIDEO_URL)).rejects.toThrow(/cannot download .*HTTP 404/);
    await expect(client(router({ put: 403 })).uploadDraft(VIDEO_URL)).rejects.toThrow(/storage answered HTTP 403/);
    await expect(client(router({ init: { data: { publish_id: "x" }, error: OK } })).uploadDraft(VIDEO_URL)).rejects.toThrow(/unexpected answer/);
  });

  it("refuses a video over our ceiling before asking TikTok for anything", async () => {
    const r = router();
    const real = r.fetchImpl;
    const fetchImpl = vi.fn(async (u: string, i?: RequestInit) =>
      u === VIDEO_URL ? json({}, 200, { arrayBuffer: async () => ({ byteLength: TIKTOK_MAX_VIDEO_BYTES + 1 }) }) : real(u, i),
    ) as unknown as typeof fetch;
    await expect(new TikTokClient(CREDS, { fetchImpl, sleepImpl: async () => {} }).uploadDraft(VIDEO_URL)).rejects.toThrow(/ceiling/);
    expect(r.calls.some((c) => c.url.includes("tiktokapis.com"))).toBe(false);
  });

  it("retries a 429 then succeeds", async () => {
    let first = true;
    const r = router();
    const real = r.fetchImpl;
    const fetchImpl = vi.fn(async (u: string, i?: RequestInit) => {
      if (u.endsWith("/inbox/video/init/") && first) {
        first = false;
        return json({}, 429);
      }
      return real(u, i);
    }) as unknown as typeof fetch;
    const res = await new TikTokClient(CREDS, { fetchImpl, sleepImpl: async () => {}, pollIntervalMs: 1, maxWaitMs: 1000 }).uploadDraft(VIDEO_URL);
    expect(res.publishId).toBe("v_inbox_file~v2.1");
  });
});

describe("userInfo", () => {
  it("returns which account the tokens belong to", async () => {
    expect(await client(router()).userInfo()).toEqual({ openId: "oid", displayName: "Ameublo Direct", username: "ameublodirect" });
  });
});

describe("tiktokCaptionToPaste", () => {
  it("drops links (not clickable on TikTok) but keeps the words around them", () => {
    const caption = "Un salon qui se monte tout seul.\n\nCanapé — 244,99 $ : https://ameublodirect.ca/products/canape\n\nLivraison gratuite.\n#ameublodirect";
    expect(tiktokCaptionToPaste(caption)).toBe("Un salon qui se monte tout seul.\n\nCanapé — 244,99 $\n\nLivraison gratuite.\n#ameublodirect");
  });
  it("never lets a supplier brand through, and stays within TikTok's caption length", () => {
    expect(tiktokCaptionToPaste("Un classique de Outsunny")).not.toMatch(/outsunny/i);
    expect(tiktokCaptionToPaste("x".repeat(5000)).length).toBe(2200);
  });
});
