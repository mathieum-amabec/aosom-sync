/**
 * FFmpeg slideshow engine — turns 1-6 product photos into a branded 9:16 MP4.
 *
 * Pipeline (per the video brief):
 *   1. Download each product image (downloadImage — SSRF/DoS guarded).
 *   2. Resize to 1080×1920 with sharp (fit: contain, navy background).
 *   3. Bake a per-product info overlay (title + price + CTA) onto each slide.
 *   4. Animate each slide with a Ken Burns zoom (zoompan).
 *   5. Overlay a static branded band (navy + logo + store URL) at the bottom.
 *   6. Concat the clips and mix in a random track from public/music/.
 *   7. Export H.264 MP4 (yuv420p, +faststart) to `outputPath`.
 *
 * Design: all heavy I/O (download, sharp, ffmpeg spawn) lives in
 * `generateSlideshowVideo`. The pure builders below (duration math, filter
 * graph, arg vector, SVG) are exported and unit-tested without invoking ffmpeg,
 * mirroring how job4-social exposes `pickRandomImages` for isolated testing.
 *
 * ── FFmpeg availability ──────────────────────────────────────────────────
 * The ffmpeg binary is resolved at runtime by `resolveFfmpegPath`:
 *   1. `FFMPEG_BIN` / `FFMPEG_PATH` env override, else
 *   2. the `ffmpeg-static` package (ships the correct binary per platform —
 *      installed at build time on Vercel's linux/x64 runtime), else
 *   3. `ffmpeg` from the system PATH.
 * `ffmpeg-static` has no win32-arm64 build, so on an arm64 dev box its default
 * resolves to null and we fall back to a system ffmpeg (or FFMPEG_BIN). See
 * docs/VIDEO-PIPELINE-FFMPEG.md for the Vercel deployment notes.
 */
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { downloadImage } from "@/lib/image-composer";
import { VIDEO_BRAND } from "@/lib/video-brand-tokens";
import { formatVideoTitle } from "@/lib/video-title-utils";

const { width: WIDTH, height: HEIGHT } = VIDEO_BRAND.format;
const FPS = 25;
/** Baseline seconds per slide; total runtime is clamped into durationTarget. */
const BASE_CLIP_SECONDS = 5;
const MAX_PRODUCTS = 6;
/** Hard ceiling so a stuck render never hangs a serverless invocation. */
const RENDER_TIMEOUT_MS = 4 * 60_000;

export type VideoLocale = "fr" | "en";

/** Minimal product shape the slideshow needs (a row from getProduct works). */
export interface SlideshowProduct {
  name: string;
  price: number;
  /** Public HTTPS product image URL (downloadImage enforces the SSRF guard). */
  imageUrl: string;
}

export interface SlideshowOptions {
  products: SlideshowProduct[]; // 1-6 products
  locale: VideoLocale;
  outputPath: string;
}

// ─── Pure helpers (unit-tested without ffmpeg) ───────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Total runtime (seconds) for N products, clamped into the brand duration target. */
export function slideshowDurationSeconds(productCount: number): number {
  const { min, max } = VIDEO_BRAND.format.durationTarget;
  return clamp(productCount * BASE_CLIP_SECONDS, min, max);
}

/** Seconds each slide is shown so the total lands in the duration target. */
export function perClipSeconds(productCount: number): number {
  if (productCount <= 0) return 0;
  return slideshowDurationSeconds(productCount) / productCount;
}

/** Ken Burns frame count per slide (zoompan `d=`), derived from per-clip seconds. */
export function perClipFrames(productCount: number, fps: number = FPS): number {
  return Math.round(perClipSeconds(productCount) * fps);
}

/** Format a price for the given locale (CA: "249.99 $" FR, "$249.99" EN). */
export function formatPrice(price: number, locale: VideoLocale): string {
  const v = Number(price).toFixed(2);
  return locale === "fr" ? `${v} $` : `$${v}`;
}

/** CTA copy per locale. */
export function ctaText(locale: VideoLocale): string {
  return locale === "fr" ? "Magasinez maintenant" : "Shop now";
}

/**
 * Pick a random music file from a list of candidate paths.
 * Returns null when none are available (caller renders a silent video).
 */
export function pickRandomMusic(files: string[]): string | null {
  const usable = files.filter((f) => typeof f === "string" && f.trim().length > 0);
  if (usable.length === 0) return null;
  return usable[Math.floor(Math.random() * usable.length)];
}

/** List the audio tracks available under public/music/ (absolute paths), or []. */
export function listMusicTracks(): string[] {
  const dir = path.resolve(process.cwd(), VIDEO_BRAND.music.dir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // no music dir yet → silent video
  }
  return entries
    .filter((f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f))
    .map((f) => path.join(dir, f));
}

/**
 * Per-product info overlay (baked onto each slide before the Ken Burns zoom).
 * Title pinned near the top, price + CTA below it, all kept clear of the bottom
 * branded band (`overlay.bandHeight`).
 */
export function buildProductOverlaySvg(product: SlideshowProduct, locale: VideoLocale): string {
  const { navy, gold, offWhite } = VIDEO_BRAND.colors;
  // Smart shorten (no mid-word cut, no ellipsis) instead of a hard 48-char slice.
  // Preserve the slideshow's own casing/wording — no UPPERCASE, no catalogue cleanup.
  const title = escapeXml(formatVideoTitle(product.name, 48, { uppercase: false, aggressive: false }));
  const price = escapeXml(formatPrice(product.price, locale));
  const cta = escapeXml(ctaText(locale));
  const titleFont = VIDEO_BRAND.font.family;
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="80" y="140" width="${WIDTH - 160}" height="6" fill="${gold}"/>
  <text x="80" y="240" font-family="${titleFont},Arial,sans-serif" font-size="68" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}">${title}</text>
  <text x="80" y="360" font-family="${titleFont},Arial,sans-serif" font-size="92" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}">${price}</text>
  <rect x="80" y="420" width="420" height="92" rx="46" fill="${gold}"/>
  <text x="290" y="480" font-family="${titleFont},Arial,sans-serif" font-size="40" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${navy}" text-anchor="middle">${cta}</text>
</svg>`;
}

/**
 * Full-frame transparent overlay carrying only the bottom branded band
 * (navy strip + gold rule + store URL). Composited statically over the
 * concatenated slides so it stays fixed while the photos zoom.
 */
export function buildBrandBandSvg(): string {
  const { navy, gold, offWhite } = VIDEO_BRAND.colors;
  const bandTop = HEIGHT - VIDEO_BRAND.overlay.bandHeight;
  const url = escapeXml(VIDEO_BRAND.overlay.storeUrl);
  const font = VIDEO_BRAND.font.family;
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="${bandTop}" width="${WIDTH}" height="${VIDEO_BRAND.overlay.bandHeight}" fill="${navy}"/>
  <rect x="0" y="${bandTop}" width="${WIDTH}" height="6" fill="${gold}"/>
  <text x="${WIDTH / 2}" y="${bandTop + VIDEO_BRAND.overlay.bandHeight / 2 + 18}" font-family="${font},Arial,sans-serif" font-size="48" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" text-anchor="middle" letter-spacing="2">${url}</text>
</svg>`;
}

/**
 * Build the ffmpeg `-filter_complex` graph.
 *
 * Inputs are ordered: [0..N-1] slides, then the band (if any), then music
 * (if any). Each slide gets a centered Ken Burns zoom; the slides are
 * concatenated; the band is overlaid statically; music volume is normalized.
 */
export function buildFilterComplex(opts: {
  slideCount: number;
  framesPerClip: number;
  hasBand: boolean;
  hasMusic: boolean;
  musicVolumeDb: number;
  width?: number;
  height?: number;
  fps?: number;
}): { filterComplex: string; videoLabel: string; audioLabel: string | null } {
  const w = opts.width ?? WIDTH;
  const h = opts.height ?? HEIGHT;
  const fps = opts.fps ?? FPS;
  const d = opts.framesPerClip;
  const parts: string[] = [];

  for (let i = 0; i < opts.slideCount; i++) {
    // z stays exactly as the brief specifies; x/y center the zoom on the slide.
    parts.push(
      `[${i}:v]zoompan=z='min(zoom+0.0015,1.5)':d=${d}:s=${w}x${h}:fps=${fps}` +
        `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',setsar=1[v${i}]`,
    );
  }

  const concatInputs = Array.from({ length: opts.slideCount }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatInputs}concat=n=${opts.slideCount}:v=1:a=0[slides]`);

  let videoLabel = "slides";
  if (opts.hasBand) {
    const bandIdx = opts.slideCount; // band input follows the slides
    parts.push(`[slides][${bandIdx}:v]overlay=0:0:format=auto[branded]`);
    videoLabel = "branded";
  }

  let audioLabel: string | null = null;
  if (opts.hasMusic) {
    const musicIdx = opts.slideCount + (opts.hasBand ? 1 : 0);
    parts.push(`[${musicIdx}:a]volume=${opts.musicVolumeDb}dB[aout]`);
    audioLabel = "aout";
  }

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}

/**
 * Assemble the full ffmpeg argument vector. Pure: no spawning, no filesystem —
 * unit-testable against a fixed expected command line.
 */
export function buildFfmpegArgs(opts: {
  slidePaths: string[];
  bandPath: string | null;
  musicPath: string | null;
  perClipSeconds: number;
  framesPerClip: number;
  musicVolumeDb: number;
  outputPath: string;
  fps?: number;
}): string[] {
  const fps = opts.fps ?? FPS;
  const args: string[] = [];

  // Each slide: a single still looped for the clip duration.
  for (const slide of opts.slidePaths) {
    args.push("-loop", "1", "-t", String(opts.perClipSeconds), "-i", slide);
  }
  if (opts.bandPath) args.push("-loop", "1", "-i", opts.bandPath);
  if (opts.musicPath) args.push("-i", opts.musicPath);

  const { filterComplex, videoLabel, audioLabel } = buildFilterComplex({
    slideCount: opts.slidePaths.length,
    framesPerClip: opts.framesPerClip,
    hasBand: !!opts.bandPath,
    hasMusic: !!opts.musicPath,
    musicVolumeDb: opts.musicVolumeDb,
    fps,
  });

  args.push("-filter_complex", filterComplex);
  args.push("-map", `[${videoLabel}]`);
  if (audioLabel) args.push("-map", `[${audioLabel}]`);

  args.push(
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
  );
  if (audioLabel) {
    args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
  }
  args.push("-movflags", "+faststart", "-y", opts.outputPath);
  return args;
}

// ─── Runtime resolution + I/O ────────────────────────────────────────────

/**
 * Resolve the ffmpeg binary: env override → ffmpeg-static → system PATH.
 * Dynamic import so a missing/unsupported ffmpeg-static build never breaks
 * module load (e.g. win32-arm64 dev boxes have no static binary).
 */
export async function resolveFfmpegPath(): Promise<string> {
  const override = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH;
  if (override) return override;
  try {
    const mod = await import("ffmpeg-static");
    const p = (mod.default ?? (mod as unknown)) as string | null;
    if (p && typeof p === "string") return p;
  } catch {
    // ffmpeg-static not installed or no binary for this platform — fall through.
  }
  return "ffmpeg"; // rely on a system-installed ffmpeg
}

/** Resolve and validate a brand logo path under public/, or null if absent. */
function resolveLogoPath(locale: VideoLocale): string | null {
  const rel = VIDEO_BRAND.logos[locale];
  const publicDir = path.resolve(process.cwd(), "public");
  const resolved = path.resolve(publicDir, rel);
  if (!resolved.startsWith(publicDir)) return null; // path-traversal guard
  return fs.existsSync(resolved) ? resolved : null;
}

/** Working dir for intermediate slides/band PNGs. /tmp on Vercel, else public/. */
function getWorkDir(): string {
  const base = process.env.VERCEL
    ? path.join("/tmp", "video-slideshow")
    : path.join(process.cwd(), "public", "social-videos", ".work");
  const dir = path.join(base, `job-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run ffmpeg, resolving on exit 0 and rejecting with the stderr tail otherwise. */
function runFfmpeg(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000); // keep only the tail
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
 * Build one branded slide PNG: product photo resized to 1080×1920 (contain,
 * navy background) with the per-product info overlay baked on top.
 */
async function renderSlide(
  product: SlideshowProduct,
  locale: VideoLocale,
  outPath: string,
): Promise<void> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);

  let base: import("sharp").Sharp;
  try {
    const buf = await downloadImage(product.imageUrl);
    base = sharpFn(buf)
      .resize(WIDTH, HEIGHT, { fit: "contain", background: navy })
      .flatten({ background: navy });
  } catch {
    // Unreachable image → solid navy slide so the render still succeeds.
    base = sharpFn({
      create: { width: WIDTH, height: HEIGHT, channels: 3, background: navy },
    });
  }

  const overlay = Buffer.from(buildProductOverlaySvg(product, locale));
  await base.composite([{ input: overlay, top: 0, left: 0 }]).png().toFile(outPath);
}

/** Render the static branded-band overlay PNG (transparent except the band). */
async function renderBand(outPath: string, logoPath: string | null): Promise<void> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;

  const bandSvg = Buffer.from(buildBrandBandSvg());
  const composites: import("sharp").OverlayOptions[] = [
    { input: bandSvg, top: 0, left: 0 },
  ];
  if (logoPath) {
    try {
      const logoH = VIDEO_BRAND.overlay.bandHeight - 80;
      const logo = await sharpFn(logoPath)
        .resize({ height: logoH, fit: "inside" })
        .png()
        .toBuffer();
      composites.push({ input: logo, top: HEIGHT - VIDEO_BRAND.overlay.bandHeight + 40, left: 60 });
    } catch {
      // Logo unreadable → band keeps just the store URL text.
    }
  }

  await sharpFn({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
}

/**
 * Generate a branded 9:16 slideshow MP4 from 1-6 product photos.
 * Returns the `outputPath` on success. Throws if products is empty / >6 or
 * if ffmpeg fails.
 */
export async function generateSlideshowVideo(options: SlideshowOptions): Promise<string> {
  const { products, locale, outputPath } = options;
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error("generateSlideshowVideo: at least one product is required");
  }
  if (products.length > MAX_PRODUCTS) {
    throw new Error(`generateSlideshowVideo: at most ${MAX_PRODUCTS} products (got ${products.length})`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const workDir = getWorkDir();

  try {
    // 1-4. Download, resize and bake the per-product overlay onto each slide.
    const slidePaths: string[] = [];
    for (let i = 0; i < products.length; i++) {
      const slidePath = path.join(workDir, `slide-${i}.png`);
      await renderSlide(products[i], locale, slidePath);
      slidePaths.push(slidePath);
    }

    // 5. Static branded band (with logo if the asset exists).
    const bandPath = path.join(workDir, "band.png");
    await renderBand(bandPath, resolveLogoPath(locale));

    // 6. Random background music (silent video if public/music/ is empty).
    const musicPath = pickRandomMusic(listMusicTracks());

    // 7. Assemble + run ffmpeg.
    const count = products.length;
    const args = buildFfmpegArgs({
      slidePaths,
      bandPath,
      musicPath,
      perClipSeconds: perClipSeconds(count),
      framesPerClip: perClipFrames(count),
      musicVolumeDb: VIDEO_BRAND.music.volume,
      outputPath,
    });

    const binary = await resolveFfmpegPath();
    await runFfmpeg(binary, args);
    return outputPath;
  } finally {
    // Best-effort cleanup of intermediate PNGs.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* leave temp files rather than fail the render */
    }
  }
}
