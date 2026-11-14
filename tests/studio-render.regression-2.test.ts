// Regression: ISSUE-003 — even with ffmpeg-static external + traced, the binary never existed
// on Vercel: npm skips install scripts not listed in "allowScripts" (build log:
// "install scripts not yet covered by allowScripts: ffmpeg-static@5.3.0"), and the cached
// node_modules never re-runs them. A prebuild hook must fetch the binary before next build.
// Found by /qa on 2026-09-28
// Report: .gstack/qa-reports/qa-report-aosom-sync-vercel-app-2026-09-28.md
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  allowScripts?: Record<string, boolean>;
  dependencies: Record<string, string>;
};

describe("ffmpeg binary is present at build time on Vercel", () => {
  it("runs scripts/ensure-ffmpeg.mjs as the prebuild hook of `npm run build`", () => {
    expect(pkg.scripts.prebuild).toBe("node scripts/ensure-ffmpeg.mjs");
    expect(pkg.scripts.build).toBe("next build");
  });

  it("allows ffmpeg-static's install script for the installed version", () => {
    const installed = JSON.parse(readFileSync(require.resolve("ffmpeg-static/package.json"), "utf8")).version as string;
    expect(pkg.allowScripts?.[`ffmpeg-static@${installed}`]).toBe(true);
  });

  it("the ensure script is Linux-only and delegates to ffmpeg-static's idempotent installer", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "ensure-ffmpeg.mjs"), "utf8");
    expect(src).toContain('process.platform !== "linux"');
    expect(src).toContain("install.js");
  });
});
