import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

vi.mock("@/lib/database", () => ({ getVideoJob: vi.fn() }));

import { GET } from "@/app/api/video-serve/[id]/route";
import { getVideoJob } from "@/lib/database";

const req = (range?: string) =>
  new Request("https://app.test/api/video-serve/1", range ? { headers: { range } } : undefined);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

// A small real file on disk so the streaming branch exercises fs.stat + createReadStream.
const BODY = "0123456789"; // 10 bytes
let tmpFile: string;

function job(over: Record<string, unknown>) {
  return {
    id: 1, engine: "ffmpeg", content_type: "product", product_skus: [], locale: "fr",
    status: "ready", video_url: null, video_path: null, error_message: null,
    created_at: 0, updated_at: 0, ...over,
  } as never;
}

describe("GET /api/video-serve/:id", () => {
  beforeAll(async () => {
    tmpFile = path.join(os.tmpdir(), `video-serve-test-${process.pid}.mp4`);
    await fsp.writeFile(tmpFile, BODY);
  });
  afterAll(async () => { await fsp.rm(tmpFile, { force: true }); });
  beforeEach(() => vi.resetAllMocks());

  it("400s on a non-numeric id", async () => {
    expect((await GET(req(), ctx("abc"))).status).toBe(400);
    expect((await GET(req(), ctx("0"))).status).toBe(400);
  });

  it("404s when the job does not exist", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(null);
    expect((await GET(req(), ctx("1"))).status).toBe(404);
  });

  it("302-redirects to the external URL when video_url is set", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({ video_url: "https://blob.test/v.mp4" }));
    const res = await GET(req(), ctx("1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://blob.test/v.mp4");
  });

  it("ignores a non-http video_url and falls through to 404", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({ video_url: "javascript:alert(1)" }));
    expect((await GET(req(), ctx("1"))).status).toBe(404);
  });

  it("404s when neither video_url nor video_path is set", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({}));
    expect((await GET(req(), ctx("1"))).status).toBe(404);
  });

  it("streams the full file with mp4 + Accept-Ranges headers", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({ video_path: tmpFile }));
    const res = await GET(req(), ctx("1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(BODY.length));
    expect(await res.text()).toBe(BODY);
  });

  it("serves a 206 partial for a Range request", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({ video_path: tmpFile }));
    const res = await GET(req("bytes=2-5"), ctx("1"));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-5/${BODY.length}`);
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("416s on an unsatisfiable range", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({ video_path: tmpFile }));
    const res = await GET(req("bytes=999-"), ctx("1"));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BODY.length}`);
  });

  it("404s when video_path points at a missing file", async () => {
    vi.mocked(getVideoJob).mockResolvedValue(job({ video_path: path.join(os.tmpdir(), "nope-xyz.mp4") }));
    expect((await GET(req(), ctx("1"))).status).toBe(404);
  });
});
