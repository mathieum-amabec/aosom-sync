#!/usr/bin/env node
/**
 * prebuild: make sure the ffmpeg-static binary exists before `next build` traces it into the
 * render functions (next.config.ts → outputFileTracingIncludes).
 *
 * Why this exists: ffmpeg-static downloads its binary from an npm INSTALL script, and the npm
 * on Vercel skips install scripts that aren't in package.json "allowScripts" (npm 11.10+ /
 * npm 12 default). Vercel also restores node_modules from its build cache ("up to date"), so
 * even an allowScripts entry wouldn't re-run a script for an already-installed package. Result
 * on 2026-09-28: no binary in the bundle, every Studio / Vidéos render died with ENOENT.
 *
 * Linux only (the Vercel build host) — dev boxes set FFMPEG_BIN or use a system ffmpeg, and
 * ffmpeg-static has no win32-arm64 build. install.js is idempotent: it exits at once when the
 * binary is already there. A download failure is loud but doesn't fail the build: the render
 * error names the missing binary (src/lib/studio/render.ts), and blocking every deploy on a
 * GitHub outage would be worse.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

if (process.platform !== "linux") {
  console.log(`[ensure-ffmpeg] ${process.platform}: skipped (Linux build hosts only)`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("ffmpeg-static/package.json"));
const binary = path.join(pkgDir, "ffmpeg");
if (existsSync(binary)) {
  console.log(`[ensure-ffmpeg] present: ${binary}`);
  process.exit(0);
}

console.log(`[ensure-ffmpeg] missing ${binary} — running ffmpeg-static's installer`);
const r = spawnSync(process.execPath, [path.join(pkgDir, "install.js")], { cwd: pkgDir, stdio: "inherit" });
if (r.status === 0 && existsSync(binary)) {
  console.log(`[ensure-ffmpeg] installed: ${binary}`);
} else {
  console.warn(`[ensure-ffmpeg] WARNING: ffmpeg binary still missing (exit ${r.status}). Video renders will fail with ENOENT.`);
}
