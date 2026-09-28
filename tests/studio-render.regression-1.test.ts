// Regression: ISSUE-001/002 — every Studio render failed on Vercel with a bare
// "Rendu ffmpeg échoué": the ffmpeg-static binary was not in the function bundle
// (spawn /ROOT/node_modules/ffmpeg-static/ffmpeg ENOENT) and the error hid the cause.
// Found by /qa on 2026-09-28
// Report: .gstack/qa-reports/qa-report-aosom-sync-vercel-app-2026-09-28.md
import { describe, it, expect, vi, afterEach } from "vitest";
import sharp from "sharp";
import os from "node:os";
import path from "node:path";
import nextConfig from "../next.config";
import { renderStudioVideo } from "@/lib/studio/render";

describe("ffmpeg-static on Vercel (next.config)", () => {
  it("keeps ffmpeg-static external so its binary path is resolved at runtime, not frozen at build", () => {
    expect(nextConfig.serverExternalPackages).toContain("ffmpeg-static");
  });
  it("traces the ffmpeg binary into every route that spawns it", () => {
    const inc = nextConfig.outputFileTracingIncludes ?? {};
    for (const route of ["/api/studio/render", "/api/videos/generate"]) {
      expect(inc[route], route).toContain("./node_modules/ffmpeg-static/ffmpeg");
    }
  });
});

describe("renderStudioVideo error message", () => {
  const prev = process.env.FFMPEG_BIN;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prev === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = prev;
  });

  it("names the missing binary and the spawn error instead of a bare 'Rendu ffmpeg échoué'", async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#888" } }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new Uint8Array(png), { status: 200 })));
    process.env.FFMPEG_BIN = path.join(os.tmpdir(), "definitely-not-ffmpeg-binary");
    const work = path.join(os.tmpdir(), `studio-regr-${Date.now()}`);
    await expect(
      renderStudioVideo(
        {
          sku: "S",
          shopifyProductId: "1",
          productTitle: "P",
          before: { url: "https://cdn.shopify.com/a.jpg", fit: "contain" },
          after: { url: "https://cdn.shopify.com/b.jpg", fit: "cover" },
          transition: "dissolve",
          durationSec: 6,
          format: "9:16",
          locale: "fr",
          musicUrl: null,
          musicStartSec: 0,
          texts: { labels: true, title: "", price: "", cta: "" },
        },
        work,
        path.join(work, "out.mp4"),
      ),
    ).rejects.toThrow(/definitely-not-ffmpeg-binary.*ENOENT/);
  });
});
