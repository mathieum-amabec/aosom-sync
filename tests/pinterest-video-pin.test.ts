import { describe, it, expect, vi } from "vitest";
import {
  PinterestClient,
  buildVideoPinBody,
  pinterestApiBase,
  readPinterestCredentials,
  PINTEREST_API_BASE,
  PINTEREST_SANDBOX_API_BASE,
  PINTEREST_VIDEO_MAX_BYTES,
} from "@/lib/pinterest-client";

const VIDEO = {
  title: "Pub Halloween — version 1",
  description: "Les meilleures déco d'Halloween.",
  link: "https://ameublodirect.ca/products/faucheuse",
  videoUrl: "https://blob.example/v.mp4",
  coverImageUrl: "https://cdn.example/cover.jpg",
};
const CREDS = { accessToken: "tok", boardId: "board-1" };
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, headers: new Headers(), json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response;

/** Router for the calls a video Pin makes; `media` answers each poll in turn (the last answer repeats). */
function router(over: { media?: string[]; register?: unknown; upload?: number; download?: number; pin?: unknown } = {}) {
  const polls = [...(over.media ?? ["processing", "succeeded"])];
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    if (url === VIDEO.videoUrl) return over.download && over.download >= 400 ? json({}, over.download) : json({});
    if (url.startsWith("https://s3.example")) return json({}, over.upload ?? 204);
    if (url.endsWith("/media") && method === "POST")
      return json(over.register ?? { media_id: "m1", upload_url: "https://s3.example/up", upload_parameters: { key: "k1", policy: "p1" } });
    if (url.includes("/media/m1")) return json({ status: polls.length > 1 ? polls.shift() : polls[0] });
    if (url.endsWith("/pins")) return json(over.pin ?? { id: "pin-9" });
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}
const client = (r: ReturnType<typeof router>, creds: { accessToken: string; boardId: string; sandbox?: boolean } = CREDS, extra = {}) =>
  new PinterestClient(creds, { fetchImpl: r.fetchImpl, sleepImpl: async () => {}, pollIntervalMs: 10, maxWaitMs: 1000, ...extra });

describe("environments", () => {
  it("production by default, sandbox when the credentials say so", () => {
    expect(pinterestApiBase()).toBe(PINTEREST_API_BASE);
    expect(pinterestApiBase(true)).toBe(PINTEREST_SANDBOX_API_BASE);
    expect(PINTEREST_SANDBOX_API_BASE).toBe("https://api-sandbox.pinterest.com/v5");
  });
  it("PINTEREST_ENV=sandbox turns the sandbox flag on; nothing else does", () => {
    const env = { PINTEREST_ACCESS_TOKEN: "a", PINTEREST_BOARD_ID: "b" };
    expect(readPinterestCredentials({ ...env, PINTEREST_ENV: "sandbox" })).toEqual({ accessToken: "a", boardId: "b", sandbox: true });
    expect(readPinterestCredentials({ ...env, PINTEREST_ENV: "production" })).toEqual({ accessToken: "a", boardId: "b" });
  });
});

describe("buildVideoPinBody", () => {
  it("references the uploaded media and the cover — no image_url source", () => {
    const b = buildVideoPinBody(VIDEO, "board-1", "m1");
    expect(b).toMatchObject({
      board_id: "board-1",
      title: VIDEO.title,
      link: VIDEO.link,
      media_source: { source_type: "video_id", media_id: "m1", cover_image_url: VIDEO.coverImageUrl },
    });
    expect((b.media_source as Record<string, unknown>).source_type).not.toBe("image_url");
  });
  it("truncates like image Pins do", () => {
    const b = buildVideoPinBody({ ...VIDEO, title: "x".repeat(150) }, "b", "m") as { title: string };
    expect(b.title.length).toBe(100);
  });
});

describe("createVideoPin — dry run", () => {
  it("records the four steps and sends nothing", async () => {
    const fetchImpl = vi.fn();
    const c = new PinterestClient(null, { dryRun: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await c.createVideoPin(VIDEO);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(c.plan.map((s) => s.step)).toEqual(["registerMedia", "uploadVideo", "awaitMedia", "createPin"]);
    expect(r.pinId).toMatch(/^dryrun-pin-/);
    expect((c.plan[3].body as { media_source: { media_id: string } }).media_source.media_id).toBe(r.mediaId);
  });
});

describe("createVideoPin — live", () => {
  it("registers, uploads to the pre-signed URL (file field last, no Pinterest token there), polls, then creates the Pin", async () => {
    const r = router();
    const c = client(r);
    const res = await c.createVideoPin(VIDEO);
    expect(res).toMatchObject({ pinId: "pin-9", mediaId: "m1", url: "https://www.pinterest.com/pin/pin-9/" });

    const urls = r.calls.map((x) => `${x.method} ${x.url}`);
    expect(urls[0]).toBe("POST https://api.pinterest.com/v5/media");
    expect(urls).toContain("GET https://blob.example/v.mp4");
    expect(urls).toContain("POST https://s3.example/up");
    expect(urls.filter((u) => u.includes("/media/m1")).length).toBe(2); // processing, then succeeded
    expect(urls[urls.length - 1]).toBe("POST https://api.pinterest.com/v5/pins");

    const up = r.calls.find((x) => x.url === "https://s3.example/up")!;
    expect(up.headers.Authorization).toBeUndefined();
    expect([...(up.body as FormData).keys()]).toEqual(["key", "policy", "file"]); // S3 requires the file LAST

    const pin = r.calls[r.calls.length - 1];
    expect(pin.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(pin.body as string).media_source).toEqual({ source_type: "video_id", media_id: "m1", cover_image_url: VIDEO.coverImageUrl });
    expect(c.plan.map((s) => s.step)).toEqual(["registerMedia", "uploadVideo", "awaitMedia", "createPin"]);
  });

  it("uses the sandbox environment when the credentials are sandbox ones", async () => {
    const r = router();
    await client(r, { ...CREDS, sandbox: true }).createVideoPin(VIDEO);
    const api = r.calls.filter((x) => x.url.includes("pinterest.com"));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((x) => x.url.startsWith("https://api-sandbox.pinterest.com/v5/"))).toBe(true);
  });

  it("waits between polls", async () => {
    const sleepImpl = vi.fn(async () => {});
    await client(router({ media: ["registered", "processing", "succeeded"] }), CREDS, { sleepImpl }).createVideoPin(VIDEO);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("stops before creating the Pin when Pinterest fails to process the video", async () => {
    const r = router({ media: ["failed"] });
    await expect(client(r).createVideoPin(VIDEO)).rejects.toThrow(/could not process the video/);
    expect(r.calls.some((x) => x.url.endsWith("/pins"))).toBe(false);
  });

  it("gives up after maxWaitMs", async () => {
    const r = router({ media: ["processing"] });
    await expect(client(r, CREDS, { maxWaitMs: 0 }).createVideoPin(VIDEO)).rejects.toThrow(/still "processing"/);
    expect(r.calls.some((x) => x.url.endsWith("/pins"))).toBe(false);
  });

  it("rejects a video over 100 MB before uploading a byte", async () => {
    const r = router();
    const real = r.fetchImpl;
    const fetchImpl = vi.fn(async (u: string, i?: RequestInit) =>
      u === VIDEO.videoUrl
        ? ({ ok: true, status: 200, arrayBuffer: async () => ({ byteLength: PINTEREST_VIDEO_MAX_BYTES + 1 }) } as unknown as Response)
        : real(u, i),
    ) as unknown as typeof fetch;
    await expect(new PinterestClient(CREDS, { fetchImpl, sleepImpl: async () => {} }).createVideoPin(VIDEO)).rejects.toThrow(/100 MB/);
    expect(r.calls.some((x) => x.url.startsWith("https://s3.example"))).toBe(false);
  });

  it("explains a failed download and a refused upload", async () => {
    await expect(client(router({ download: 404 })).createVideoPin(VIDEO)).rejects.toThrow(/cannot download .*HTTP 404/);
    await expect(client(router({ upload: 403 })).createVideoPin(VIDEO)).rejects.toThrow(/storage answered HTTP 403/);
  });

  it("refuses an unexpected /media answer and a Pin answer without an id", async () => {
    await expect(client(router({ register: { media_id: "m1" } })).createVideoPin(VIDEO)).rejects.toThrow(/unexpected answer/);
    await expect(client(router({ pin: {} })).createVideoPin(VIDEO)).rejects.toThrow(/returned no id/);
  });
});
