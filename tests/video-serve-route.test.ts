import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/database", () => ({ getFacebookDraft: vi.fn() }));
vi.mock("@/lib/video-engines/video-store", () => ({ resolveVideoPath: vi.fn() }));

import { GET } from "@/app/api/video-serve/[id]/route";
import { getFacebookDraft } from "@/lib/database";
import { resolveVideoPath } from "@/lib/video-engines/video-store";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/video-serve/1", { headers });

const BODY = Buffer.from("MP4DATA-0123456789"); // 18 bytes

let tmpFile = "";
beforeEach(() => {
  vi.clearAllMocks();
  tmpFile = path.join(os.tmpdir(), `vs-test-${process.pid}-${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, BODY);
});
afterEach(() => {
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
});

describe("GET /api/video-serve/[id]", () => {
  it("streams the full MP4 with the right headers", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ videoPath: tmpFile } as never);
    vi.mocked(resolveVideoPath).mockReturnValue(tmpFile);

    const res = await GET(req(), ctx("1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(BODY.length));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(BODY)).toBe(true);
  });

  it("serves a 206 partial for a Range request", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ videoPath: tmpFile } as never);
    vi.mocked(resolveVideoPath).mockReturnValue(tmpFile);

    const res = await GET(req({ range: "bytes=0-3" }), ctx("1"));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${BODY.length}`);
    expect(res.headers.get("content-length")).toBe("4");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(BODY.subarray(0, 4))).toBe(true);
  });

  it("416s for an unsatisfiable range", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ videoPath: tmpFile } as never);
    vi.mocked(resolveVideoPath).mockReturnValue(tmpFile);
    const res = await GET(req({ range: "bytes=999-1000" }), ctx("1"));
    expect(res.status).toBe(416);
  });

  it("400s on a non-numeric id", async () => {
    const res = await GET(req(), ctx("abc"));
    expect(res.status).toBe(400);
  });

  it("404s when the draft has no video_path", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ videoPath: null } as never);
    const res = await GET(req(), ctx("1"));
    expect(res.status).toBe(404);
  });

  it("404s (not 500) when video_path escapes the video dir", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ videoPath: "../../etc/passwd" } as never);
    vi.mocked(resolveVideoPath).mockImplementation(() => {
      throw new Error("Invalid video path");
    });
    const res = await GET(req(), ctx("1"));
    expect(res.status).toBe(404);
  });

  it("404s when the file is missing on disk", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ videoPath: tmpFile } as never);
    vi.mocked(resolveVideoPath).mockReturnValue(tmpFile + ".gone");
    const res = await GET(req(), ctx("1"));
    expect(res.status).toBe(404);
  });
});
