/**
 * Remix render engine (Module F).
 *
 * renderRemix turns a RemixConfig into either:
 *   - a dry-run MANIFEST (dryRun:true) — the selected clips + estimated runtime
 *     + upload target, with NO clip download, NO ffmpeg, NO Blob write; or
 *   - a real MP4: download each selected demand-gen clip, concat them with
 *     xfade crossfades, bookended by branded intro/outro cards and royalty-free
 *     music, then upload to the PUBLIC Vercel Blob store and return its URL.
 *
 * Because every source clip is already a rendered, store-branded demand-gen
 * video on a public blob, the marginal cost of a remix is one concat + one
 * upload — no re-render from the Aosom sources.
 *
 * Reuses Module A primitives (ratioDimensions, resolveFfmpegPath,
 * getDefaultMusicTrack, the VIDEO_BRAND tokens) and the same PUBLIC-blob upload
 * contract Meta/YouTube ingest depend on.
 */
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { VIDEO_BRAND } from "@/lib/video-brand-tokens";
import { resolveFfmpegPath } from "@/lib/video-engines/ffmpeg-slideshow";
import { ratioDimensions } from "@/lib/slideshow/render";
import { getDefaultMusicTrack } from "../music";
import { selectRemixClips, fetchRemixClips } from "./selector";
import type { SlideshowBrand, SlideshowLanguage, SlideshowRatio } from "../types";
import type { RemixConfig, RemixClip, RemixResult, RemixManifest } from "./types";

const FPS = 25;
const INTRO_SEC = 2;
const OUTRO_SEC = 2;
const XFADE_SEC = 0.5;
const MUSIC_FADE_IN_SEC = 1;
const MUSIC_FADE_OUT_SEC = 2;
const RENDER_TIMEOUT_MS = 8 * 60_000;

/** Per-brand store identity for the bookend cards. */
const BRAND_STORE_URL: Record<SlideshowBrand, string> = {
  ameublo: "ameublodirect.ca",
  furnish: "furnishdirect.ca",
};

/** French intro headlines per theme; `n` is the clip count ("8 idées …"). */
const INTRO_FR: Record<string, (n: number) => string> = {
  "ete-cour": (n) => `${n} idées pour votre cour cet été 🌿`,
  maison: (n) => `${n} idées déco pour la maison 🏡`,
  enfants: (n) => `${n} trouvailles pour les enfants 🧸`,
  bureau: (n) => `${n} idées pour le bureau 💼`,
  animaux: (n) => `${n} essentiels pour vos animaux 🐾`,
  soldes: (n) => `${n} aubaines à ne pas manquer 🔥`,
};

// ─── Pure helpers (unit-testable without ffmpeg) ─────────────────────────────

/** Sanitize a ratio for use in a Blob key (":" → "x"). */
export function ratioKey(ratio: SlideshowRatio): string {
  return ratio.replace(":", "x");
}

/** PUBLIC Blob object key a real remix writes to. */
export function remixBlobPath(config: RemixConfig, timestamp: number): string {
  return `slideshows/${config.brand}/remix/${config.theme}/${ratioKey(config.ratio)}/${timestamp}.mp4`;
}

/** Per-segment durations: [intro, ...clip durations, outro]. */
export function segmentDurations(clips: RemixClip[]): number[] {
  return [INTRO_SEC, ...clips.map((c) => c.duration_sec), OUTRO_SEC];
}

/**
 * Total runtime with xfade overlaps: sum(segments) - (segments-1) * xfade.
 * Each crossfade swallows XFADE_SEC of overlap between adjacent segments.
 */
export function estimateRemixDuration(clips: RemixClip[]): number {
  const durs = segmentDurations(clips);
  const total = durs.reduce((a, b) => a + b, 0) - (durs.length - 1) * XFADE_SEC;
  return Math.round(total * 100) / 100;
}

/** The intro headline for a theme / clip count / language. */
export function introTitle(theme: string, n: number, language: SlideshowLanguage): string {
  if (language === "en") return `${n} ideas you'll love`;
  const fn = INTRO_FR[theme];
  return fn ? fn(n) : `${n} idées à découvrir ✨`;
}

/**
 * Build the dry-run manifest: the selected clips, the estimated runtime, and
 * the PUBLIC blob target — pure, no I/O beyond the (cached) clip selection done
 * by the caller.
 */
export function buildRemixManifest(
  config: RemixConfig,
  clips: RemixClip[],
  timestamp: number,
): RemixManifest {
  return {
    theme: config.theme,
    clips,
    estimatedDurationSec: estimateRemixDuration(clips),
    wouldUploadTo: remixBlobPath(config, timestamp),
    dryRun: true,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** "#1A2340" → "0x1A2340" for ffmpeg pad color. */
function ffmpegColor(hex: string): string {
  return `0x${hex.replace(/^#/, "")}`;
}

/** Intro card SVG: the themed headline, centered. */
export function buildIntroSvg(
  config: RemixConfig,
  clipCount: number,
  dims: { width: number; height: number },
): string {
  const { gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const title = escapeXml(introTitle(config.theme, clipCount, config.language));
  const cx = dims.width / 2;
  const cy = dims.height / 2;
  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${cx}" y="${cy - 20}" font-family="${font},Arial,sans-serif" font-size="72" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" text-anchor="middle">${title}</text>
    <rect x="${cx - 120}" y="${cy + 30}" width="240" height="8" fill="${gold}"/>
  </svg>`;
}

/** Outro card SVG: store URL, centered. */
export function buildOutroSvg(
  config: RemixConfig,
  dims: { width: number; height: number },
): string {
  const { gold } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const url = escapeXml(BRAND_STORE_URL[config.brand]);
  const cx = dims.width / 2;
  const cy = dims.height / 2;
  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${cx}" y="${cy}" font-family="${font},Arial,sans-serif" font-size="84" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}" text-anchor="middle">${url}</text>
  </svg>`;
}

/**
 * Build the xfade-crossfade `-filter_complex` over [intro, ...clips, outro].
 * Unlike the Module A stills pipeline this does NOT zoompan — the clips are
 * already moving video — it only normalizes each segment (scale/pad/fps/sar/
 * format) then chains xfades. Pure / unit-testable.
 *
 * Inputs are ordered [0..count-1] segments, then music (if any).
 */
export function buildRemixFilterComplex(opts: {
  durations: number[];
  dims: { width: number; height: number };
  fps?: number;
  xfadeSec?: number;
  hasMusic: boolean;
  musicVolumeDb: number;
  totalSec: number;
  padColor?: string;
}): { filterComplex: string; videoLabel: string; audioLabel: string | null } {
  const fps = opts.fps ?? FPS;
  const x = opts.xfadeSec ?? XFADE_SEC;
  const { width: w, height: h } = opts.dims;
  const count = opts.durations.length;
  if (count === 0) {
    throw new Error("buildRemixFilterComplex: durations must contain at least one segment");
  }
  const pad = opts.padColor ?? ffmpegColor(VIDEO_BRAND.colors.navy);
  const parts: string[] = [];

  // Normalize every segment to the same frame, fps, sar and pixel format so
  // xfade can chain them (still-image inputs and real clips alike).
  for (let i = 0; i < count; i++) {
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${pad},` +
        `fps=${fps},setsar=1,format=yuv420p[v${i}]`,
    );
  }

  // Chain xfades. offset_i = sum(dur[0..i-1]) - i*x.
  let prev = "v0";
  let cumulative = 0;
  for (let i = 1; i < count; i++) {
    cumulative += opts.durations[i - 1];
    const offset = Math.max(0, Math.round((cumulative - i * x) * 1000) / 1000);
    const out = i === count - 1 ? "vout" : `xf${i}`;
    parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${x}:offset=${offset}[${out}]`);
    prev = out;
  }
  const videoLabel = count <= 1 ? "v0" : "vout";

  let audioLabel: string | null = null;
  if (opts.hasMusic) {
    const musicIdx = count; // music input follows the segments
    const fadeOutStart = Math.max(0, opts.totalSec - MUSIC_FADE_OUT_SEC);
    parts.push(
      `[${musicIdx}:a]volume=${opts.musicVolumeDb}dB,` +
        `afade=t=in:st=0:d=${MUSIC_FADE_IN_SEC},` +
        `afade=t=out:st=${fadeOutStart}:d=${MUSIC_FADE_OUT_SEC}[aout]`,
    );
    audioLabel = "aout";
  }

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}

// ─── I/O + render ────────────────────────────────────────────────────────────

function getWorkDir(): string {
  const base = process.env.VERCEL
    ? path.join("/tmp", "remix")
    : path.join(process.cwd(), "public", "social-videos", ".work");
  const dir = path.join(base, `remix-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`renderRemix: failed to download clip ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(dest, buf);
}

/** Render a full-frame card PNG (navy background + the given SVG overlay). */
async function renderCardPng(
  svg: string,
  dims: { width: number; height: number },
  outPath: string,
): Promise<void> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);
  await sharpFn({ create: { width: dims.width, height: dims.height, channels: 3, background: navy } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outPath);
}

function runFfmpeg(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg failed to start (${binary}): ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Render a remix compilation.
 *
 * dryRun → returns { manifest } describing the render, writing nothing.
 * Otherwise → downloads + concats the clips, uploads the MP4 to the PUBLIC
 * Vercel Blob store, and returns { blobUrl }. Throws when no clip matches the
 * theme, the config is unusable, or the Blob token is missing.
 */
export async function renderRemix(config: RemixConfig): Promise<RemixResult> {
  const timestamp = Date.now();

  if (config.dryRun) {
    // Previews can use the cached selection (cheap, repeatable).
    const preview = await selectRemixClips(config);
    return { manifest: buildRemixManifest(config, preview, timestamp), clipCount: preview.length };
  }

  // Real render: fresh random draw each build (bypass the 5-min preview cache).
  const clips = await fetchRemixClips(config);

  if (clips.length === 0) {
    throw new Error(
      `renderRemix: no demand-gen clips matched theme="${config.theme}" ratio="${config.ratio}"`,
    );
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("renderRemix: BLOB_READ_WRITE_TOKEN is required for a real render (public store)");
  }

  const dims = ratioDimensions(config.ratio);
  const durations = segmentDurations(clips);
  const totalSec = estimateRemixDuration(clips);
  const workDir = getWorkDir();

  try {
    // 1. Branded intro/outro cards.
    const introPath = path.join(workDir, "intro.png");
    const outroPath = path.join(workDir, "outro.png");
    await renderCardPng(buildIntroSvg(config, clips.length, dims), dims, introPath);
    await renderCardPng(buildOutroSvg(config, dims), dims, outroPath);

    // 2. Download each source clip from its PUBLIC blob_url.
    const clipPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(workDir, `clip-${i}.mp4`);
      await downloadToFile(clips[i].blob_url, p);
      clipPaths.push(p);
    }

    // 3. Music (bundled royalty-free default → silent fallback).
    const musicPath = getDefaultMusicTrack();

    // 4. ffmpeg arg vector: intro still, clips, outro still, then music.
    const args: string[] = [];
    args.push("-loop", "1", "-t", String(INTRO_SEC), "-i", introPath);
    for (const p of clipPaths) args.push("-i", p);
    args.push("-loop", "1", "-t", String(OUTRO_SEC), "-i", outroPath);
    if (musicPath) args.push("-i", musicPath);

    const { filterComplex, videoLabel, audioLabel } = buildRemixFilterComplex({
      durations,
      dims,
      hasMusic: !!musicPath,
      musicVolumeDb: VIDEO_BRAND.music.volume,
      totalSec,
    });

    const outPath = path.join(workDir, "out.mp4");
    args.push("-filter_complex", filterComplex, "-map", `[${videoLabel}]`);
    if (audioLabel) args.push("-map", `[${audioLabel}]`);
    args.push("-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-t", String(totalSec));
    if (audioLabel) args.push("-c:a", "aac", "-b:a", "128k");
    args.push("-movflags", "+faststart", "-y", outPath);

    const binary = await resolveFfmpegPath();
    await runFfmpeg(binary, args);

    // 5. Upload to the PUBLIC Vercel Blob store.
    const { put } = await import("@vercel/blob");
    const buffer = await fs.promises.readFile(outPath);
    const blob = await put(remixBlobPath(config, timestamp), buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return { blobUrl: blob.url, clipCount: clips.length };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* leave temp files rather than fail the render */
    }
  }
}
