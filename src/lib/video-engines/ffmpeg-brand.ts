/**
 * Best-effort FFmpeg branding pass for raw engine clips (Kling).
 *
 * Takes a downloaded clip and produces a 9:16 branded MP4: the clip fitted into
 * a vertical frame, a navy band painted along the bottom, and the brand logo
 * overlaid on the band when a local asset is available.
 *
 * Branding is BEST-EFFORT and never fatal: if the `ffmpeg` binary is missing
 * (common on Vercel serverless) or the render fails, we fall back to delivering
 * the raw clip at `outputPath` and report `branded: false`. The pipeline still
 * yields a usable video — same degrade-gracefully contract as the rest of the
 * video stack.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { VIDEO_BRAND, brandLogoAsset, type VideoLocale } from "./video-brand";

export interface BrandOverlayResult {
  /** Path the (branded or raw) MP4 was written to — always === outputPath. */
  outputPath: string;
  /** false → ffmpeg unavailable/failed; outputPath holds the unbranded raw clip. */
  branded: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Local logo asset bundled under public/, or null when not present. */
function localLogoPath(locale: VideoLocale): string | null {
  const p = path.join(process.cwd(), "public", brandLogoAsset(locale));
  return fs.existsSync(p) ? p : null;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // ENOENT when ffmpeg isn't installed
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

/**
 * Apply the brand overlay to `inputPath`, writing the result to `outputPath`.
 * Returns { outputPath, branded } — branded is false when ffmpeg couldn't run.
 */
export async function applyBrandOverlay(
  inputPath: string,
  outputPath: string,
  opts: { locale: VideoLocale; timeoutMs?: number },
): Promise<BrandOverlayResult> {
  const { width, height } = VIDEO_BRAND.reel;
  const bandH = VIDEO_BRAND.bandHeight;
  const navy = VIDEO_BRAND.navy.replace("#", "0x");
  const logo = localLogoPath(opts.locale);

  // Fit the clip into the vertical frame, then paint the navy band at the bottom.
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const band = `drawbox=x=0:y=${height - bandH}:w=${width}:h=${bandH}:color=${navy}@1.0:t=fill`;

  let sourceArgs: string[];
  if (logo) {
    // Overlay the logo centered within the navy band.
    const logoH = Math.round(bandH * 0.6);
    const logoY = height - bandH + Math.round(bandH * 0.2);
    const filter = `[0:v]${fit},${band}[bg];[1:v]scale=-1:${logoH}[lg];[bg][lg]overlay=(W-w)/2:${logoY}`;
    sourceArgs = ["-i", inputPath, "-i", logo, "-filter_complex", filter];
  } else {
    sourceArgs = ["-i", inputPath, "-vf", `${fit},${band}`];
  }

  const args = ["-y", ...sourceArgs, "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath];

  try {
    await runFfmpeg(args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { outputPath, branded: true };
  } catch (err) {
    console.warn(`[kling] brand overlay skipped (${err instanceof Error ? err.message : err}); using raw clip`);
    if (path.resolve(inputPath) !== path.resolve(outputPath)) {
      try {
        fs.copyFileSync(inputPath, outputPath);
      } catch (copyErr) {
        console.warn(`[kling] raw-clip fallback copy failed: ${copyErr}`);
      }
    }
    return { outputPath, branded: false };
  }
}
