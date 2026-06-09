/**
 * Where rendered engine clips (Kling / FFmpeg) live, and how to resolve a stored
 * video_path back to a safe absolute path for streaming.
 *
 * Mirrors image-composer's getOutputDir/resolveImagePath: writable /tmp on Vercel
 * serverless, public/ in local dev. The resolver is the security boundary for the
 * public /api/video-serve route — it rejects anything outside the video dir so a
 * poisoned video_path can't turn the route into an arbitrary-file reader.
 */
import path from "node:path";
import fs from "node:fs";

/** The directory rendered clips are written to (created on first use). */
export function getVideoOutputDir(): string {
  const dir = process.env.VERCEL
    ? path.join("/tmp", "product-videos")
    : path.join(process.cwd(), "public", "product-videos");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a stored video_path (absolute or relative to the video dir) to an
 * absolute path, throwing when it escapes the video output dir. Accepts a bare
 * filename or a path already inside the dir.
 */
export function resolveVideoPath(videoPath: string): string {
  const base = path.resolve(getVideoOutputDir());
  const resolved = path.isAbsolute(videoPath) ? path.resolve(videoPath) : path.resolve(base, videoPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Invalid video path");
  }
  return resolved;
}
