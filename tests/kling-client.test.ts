import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/config", () => ({
  env: { klingApiKey: "kk_test" as string | undefined },
  CLAUDE: { MODEL: "claude-test" },
}));
vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: vi.fn() }));
vi.mock("@/lib/video-engines/ffmpeg-brand", () => ({ applyBrandOverlay: vi.fn() }));

import { env } from "@/lib/config";
import { getAnthropicClient } from "@/lib/content-generator";
import { applyBrandOverlay } from "@/lib/video-engines/ffmpeg-brand";
import {
  selectBestImage,
  fallbackCinematicPrompt,
  buildCinematicPrompt,
  createImage2VideoTask,
  getKlingVideoStatus,
  generateKlingVideo,
  isKlingConfigured,
} from "@/lib/video-engines/kling-client";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  (env as { klingApiKey?: string }).klingApiKey = "kk_test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("selectBestImage / fallbackCinematicPrompt", () => {
  it("picks the first https image", () => {
    expect(selectBestImage({ name: "Chair", images: ["", "http://x/a.jpg", "https://cdn/b.jpg"] })).toBe("https://cdn/b.jpg");
  });
  it("returns null when there is no https image", () => {
    expect(selectBestImage({ name: "Chair", images: [] })).toBeNull();
  });
  it("templated fallback follows the cinematic style", () => {
    expect(fallbackCinematicPrompt({ name: "oak desk", images: [] })).toContain("slow cinematic zoom on a oak desk");
  });
});

describe("buildCinematicPrompt", () => {
  it("uses Claude's single line when available", async () => {
    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: '"dramatic dolly on a sofa"\n' }] }) },
    } as never);
    const p = await buildCinematicPrompt({ name: "sofa", images: [] }, "en");
    expect(p).toBe("dramatic dolly on a sofa");
  });
  it("falls back to the template when Claude throws", async () => {
    vi.mocked(getAnthropicClient).mockImplementation(() => {
      throw new Error("no key");
    });
    const p = await buildCinematicPrompt({ name: "lamp", images: [] }, "fr");
    expect(p).toBe(fallbackCinematicPrompt({ name: "lamp", images: [] }));
  });
});

describe("createImage2VideoTask / getKlingVideoStatus", () => {
  it("POSTs image2video and returns the task id", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { task_id: "t1" } }));
    const id = await createImage2VideoTask({ imageUrl: "https://cdn/a.jpg", prompt: "zoom" });
    expect(id).toBe("t1");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.klingai.com/v1/videos/image2video");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ image_url: "https://cdn/a.jpg", prompt: "zoom", duration: 5, aspect_ratio: "9:16" });
  });
  it("no-ops to null without a key", async () => {
    (env as { klingApiKey?: string }).klingApiKey = undefined;
    expect(isKlingConfigured()).toBe(false);
    expect(await createImage2VideoTask({ imageUrl: "x", prompt: "y" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("maps succeed → completed + url", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn/c.mp4" }] } } }));
    expect(await getKlingVideoStatus("t1")).toEqual({ status: "completed", url: "https://cdn/c.mp4" });
  });
  it("maps failed → failed", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { task_status: "failed" } }));
    expect(await getKlingVideoStatus("t1")).toEqual({ status: "failed", url: null });
  });
});

describe("generateKlingVideo (full pipeline)", () => {
  it("renders, downloads and brands the clip → returns outputPath", async () => {
    const outputPath = path.join(os.tmpdir(), `kling-test-${process.pid}-${Date.now()}.mp4`);
    // Claude prompt
    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "zoom on chair" }] }) },
    } as never);
    // ffmpeg branding: write the final file, report branded
    vi.mocked(applyBrandOverlay).mockImplementation(async (_input: string, output: string) => {
      fs.writeFileSync(output, Buffer.from("BRANDED"));
      return { outputPath: output, branded: true };
    });
    fetchMock.mockImplementation((url: string, opts: { method?: string } = {}) => {
      if (url.endsWith("/videos/image2video") && opts.method === "POST") return Promise.resolve(json(200, { data: { task_id: "t1" } }));
      if (url.includes("/videos/image2video/t1")) return Promise.resolve(json(200, { data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn/clip.mp4" }] } } }));
      // clip download
      return Promise.resolve(new Response(Buffer.from("RAWCLIP")));
    });

    const result = await generateKlingVideo(
      { product: { name: "chair", images: ["https://cdn/a.jpg"], sku: "SKU1" }, locale: "fr", outputPath },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(result).toBe(outputPath);
    expect(fs.readFileSync(outputPath).toString()).toBe("BRANDED");
    expect(applyBrandOverlay).toHaveBeenCalledWith(`${outputPath}.raw.mp4`, outputPath, { locale: "fr" });
    fs.unlinkSync(outputPath);
  });

  it("no-ops to null when KLING_API_KEY is unset", async () => {
    (env as { klingApiKey?: string }).klingApiKey = undefined;
    const r = await generateKlingVideo({ product: { name: "x", images: ["https://cdn/a.jpg"] }, locale: "fr", outputPath: "/tmp/none.mp4" });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the product has no usable image", async () => {
    const r = await generateKlingVideo({ product: { name: "x", images: [] }, locale: "fr", outputPath: "/tmp/none.mp4" });
    expect(r).toBeNull();
  });
});
