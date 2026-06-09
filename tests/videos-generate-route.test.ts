import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock everything the routes touch so neither libsql (DB) nor sharp/ffmpeg
// (engine) load — both lack win-arm64 native builds. `after` runs the callback
// synchronously so we can assert the background render's DB writes.
const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getSessionRole: vi.fn() }));
const db = vi.hoisted(() => ({
  createVideoJob: vi.fn(),
  updateVideoJob: vi.fn(),
  getVideoJob: vi.fn(),
  getProduct: vi.fn(),
}));
const engine = vi.hoisted(() => ({ generateSlideshowVideo: vi.fn() }));
const blob = vi.hoisted(() => ({ put: vi.fn() }));
const fsp = vi.hoisted(() => ({ readFile: vi.fn() }));
const afterCbs = vi.hoisted(() => ({ run: [] as Array<() => unknown> }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/database", () => db);
vi.mock("@/lib/video-engines/ffmpeg-slideshow", () => engine);
vi.mock("@vercel/blob", () => blob);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: fsp.readFile };
});
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      afterCbs.run.push(cb);
    },
  };
});

import { POST, runFfmpegGeneration } from "@/app/api/videos/generate/route";
import { GET } from "@/app/api/videos/[id]/status/route";

function postReq(body: unknown): Request {
  return new Request("https://app.test/api/videos/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PRODUCT = { sku: "A1", name: "Sofa", price: 499.99, image1: "https://x/a.jpg" };

beforeEach(() => {
  vi.clearAllMocks();
  afterCbs.run = [];
  // No Blob token by default → runFfmpegGeneration uses the /api/video-serve URL.
  delete process.env.BLOB_READ_WRITE_TOKEN;
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  db.getProduct.mockResolvedValue(PRODUCT);
  db.createVideoJob.mockResolvedValue({ id: 7 });
  db.updateVideoJob.mockResolvedValue(undefined);
  engine.generateSlideshowVideo.mockResolvedValue("/tmp/videos/video-7.mp4");
  blob.put.mockResolvedValue({ url: "https://blob.test/videos/video-7.mp4" });
  fsp.readFile.mockResolvedValue(Buffer.from("mp4-bytes"));
});

// ─── POST /api/videos/generate ────────────────────────────────────────

describe("POST /api/videos/generate", () => {
  it("401 when unauthenticated", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await POST(postReq({ engine: "ffmpeg", productSkus: ["A1"], locale: "fr" }));
    expect(res.status).toBe(401);
    expect(db.createVideoJob).not.toHaveBeenCalled();
  });

  it("403 for reviewer role", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    const res = await POST(postReq({ engine: "ffmpeg", productSkus: ["A1"], locale: "fr" }));
    expect(res.status).toBe(403);
  });

  it("400 on invalid body", async () => {
    const res = await POST(postReq({ engine: "kling", productSkus: ["A1"], locale: "fr" }));
    expect(res.status).toBe(400);
  });

  it("400 when none of the SKUs resolve to a product", async () => {
    db.getProduct.mockResolvedValue(null);
    const res = await POST(postReq({ engine: "ffmpeg", productSkus: ["NOPE"], locale: "fr" }));
    expect(res.status).toBe(400);
    expect(db.createVideoJob).not.toHaveBeenCalled();
  });

  it("202 + jobId, flips job to generating, schedules the render", async () => {
    const res = await POST(postReq({ engine: "ffmpeg", productSkus: ["A1"], locale: "fr" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: 7 });

    expect(db.createVideoJob).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "ffmpeg", contentType: "product", productSkus: ["A1"], locale: "fr" }),
    );
    expect(db.updateVideoJob).toHaveBeenCalledWith(7, { status: "generating" });

    // The render was scheduled via after() but not yet run.
    expect(engine.generateSlideshowVideo).not.toHaveBeenCalled();
    expect(afterCbs.run).toHaveLength(1);

    // Running it renders and flips the job to ready.
    await afterCbs.run[0]();
    expect(engine.generateSlideshowVideo).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "fr", outputPath: expect.stringContaining("video-7.mp4") }),
    );
    expect(db.updateVideoJob).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "ready", video_url: "/api/video-serve/7" }),
    );
  });
});

// ─── runFfmpegGeneration ──────────────────────────────────────────────

describe("runFfmpegGeneration", () => {
  it("records ready + video_path/url on success (no Blob token → no upload)", async () => {
    await runFfmpegGeneration(9, [{ name: "X", price: 1, imageUrl: "u" }], "en", "/tmp/videos/video-9.mp4");
    expect(db.updateVideoJob).toHaveBeenCalledWith(9, {
      status: "ready",
      video_path: "/tmp/videos/video-9.mp4",
      video_url: "/api/video-serve/9",
    });
    // Without a token the Blob branch is skipped entirely.
    expect(fsp.readFile).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });

  it("uploads the MP4 to Vercel Blob and stores its URL when a token is set", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
    blob.put.mockResolvedValue({ url: "https://blob.test/videos/video-9.mp4" });
    try {
      await runFfmpegGeneration(9, [{ name: "X", price: 1, imageUrl: "u" }], "en", "/tmp/videos/video-9.mp4");
      expect(fsp.readFile).toHaveBeenCalledWith("/tmp/videos/video-9.mp4");
      expect(blob.put).toHaveBeenCalledWith(
        "videos/video-9.mp4",
        expect.anything(),
        expect.objectContaining({
          access: "public",
          contentType: "video/mp4",
          addRandomSuffix: false,
          allowOverwrite: true,
        }),
      );
      expect(db.updateVideoJob).toHaveBeenCalledWith(9, {
        status: "ready",
        video_path: "/tmp/videos/video-9.mp4",
        video_url: "https://blob.test/videos/video-9.mp4",
      });
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });

  it("falls back to the serve URL (still ready) when the Blob upload fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
    blob.put.mockRejectedValue(new Error("blob 500"));
    try {
      await runFfmpegGeneration(9, [{ name: "X", price: 1, imageUrl: "u" }], "en", "/tmp/videos/video-9.mp4");
      // A transient Blob failure must not waste the render — job stays ready,
      // served from disk.
      expect(db.updateVideoJob).toHaveBeenCalledWith(9, {
        status: "ready",
        video_path: "/tmp/videos/video-9.mp4",
        video_url: "/api/video-serve/9",
      });
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });

  it("records error + message on failure (never throws)", async () => {
    engine.generateSlideshowVideo.mockRejectedValue(new Error("ffmpeg exploded"));
    await expect(
      runFfmpegGeneration(9, [{ name: "X", price: 1, imageUrl: "u" }], "en", "/tmp/x.mp4"),
    ).resolves.toBeUndefined();
    expect(db.updateVideoJob).toHaveBeenCalledWith(9, {
      status: "error",
      error_message: "ffmpeg exploded",
    });
  });
});

// ─── GET /api/videos/:id/status ───────────────────────────────────────

describe("GET /api/videos/:id/status", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("401 when unauthenticated", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await GET(new Request("https://app.test/api/videos/7/status"), ctx("7"));
    expect(res.status).toBe(401);
  });

  it("400 on invalid id", async () => {
    const res = await GET(new Request("https://app.test/api/videos/abc/status"), ctx("abc"));
    expect(res.status).toBe(400);
  });

  it("404 when the job is missing", async () => {
    db.getVideoJob.mockResolvedValue(null);
    const res = await GET(new Request("https://app.test/api/videos/7/status"), ctx("7"));
    expect(res.status).toBe(404);
  });

  it("200 returns status, video_url, error_message", async () => {
    db.getVideoJob.mockResolvedValue({
      id: 7,
      status: "ready",
      video_url: "/api/video-serve/7",
      error_message: null,
    });
    const res = await GET(new Request("https://app.test/api/videos/7/status"), ctx("7"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ready",
      video_url: "/api/video-serve/7",
      error_message: null,
    });
  });
});
