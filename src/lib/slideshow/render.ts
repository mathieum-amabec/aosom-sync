/**
 * Slideshow render engine (Module A core).
 *
 * renderSlideshow turns a validated SlideshowConfig into either:
 *   - a dry-run MANIFEST (dryRun:true) — a full description of what would be
 *     produced, with NO image download, NO ffmpeg, NO Blob write; or
 *   - a real MP4 uploaded to the PUBLIC Vercel Blob store, returning its URL.
 *
 * It reuses the existing ffmpeg pipeline's primitives (resolveFfmpegPath,
 * formatPrice/ctaText, the brand tokens, downloadImage's SSRF guard) and adds:
 * multi-ratio output, branded intro/outro cards, per-slide Ken Burns, xfade
 * crossfades, a conditional discount badge, and royalty-free music with fades.
 *
 * Hard rules enforced here (see validate.ts): every image is a cdn.shopify.com
 * URL, supplier brand names are stripped from overlays (formatVideoTitle), and a
 * discount badge shows ONLY when compare_at >= price * 1.10.
 */
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { downloadImage } from "@/lib/image-composer";
import { VIDEO_BRAND } from "@/lib/video-brand-tokens";
import { formatVideoTitle } from "@/lib/video-title-utils";
import {
  resolveFfmpegPath,
  formatPrice,
  ctaText,
  type VideoLocale,
} from "@/lib/video-engines/ffmpeg-slideshow";
import { getDefaultMusicTrack } from "./music";
import { validateSlideshowConfig, shouldShowBadge, discountPct, isShopifyCdnUrl } from "./validate";
import {
  type SlideshowConfig,
  type SlideshowItem,
  type SlideshowResult,
  type SlideshowManifest,
  type ManifestItem,
  type SlideshowRatio,
  type SlideshowBrand,
} from "./types";

const FPS = 25;
const INTRO_SEC = 2;
const OUTRO_SEC = 2;
const PER_SLIDE_SEC = 3.5;
const XFADE_SEC = 0.5;
const MUSIC_FADE_IN_SEC = 1;
const MUSIC_FADE_OUT_SEC = 2;
const RENDER_TIMEOUT_MS = 5 * 60_000;

/** Per-brand store identity for the cards (colors/font come from VIDEO_BRAND). */
const BRAND_STORE_URL: Record<SlideshowBrand, string> = {
  ameublo: "ameublodirect.ca",
  furnish: "furnishdirect.ca",
};

// ─── Pure helpers (unit-tested without ffmpeg) ───────────────────────────

/** Pixel dimensions for an output ratio. */
export function ratioDimensions(ratio: SlideshowRatio): { width: number; height: number } {
  switch (ratio) {
    case "1:1":
      return { width: 1080, height: 1080 };
    case "16:9":
      return { width: 1920, height: 1080 };
    case "9:16":
    default:
      return { width: 1080, height: 1920 };
  }
}

/** Number of visual segments: intro card + N slides + outro card. */
export function segmentCount(itemCount: number): number {
  return itemCount + 2;
}

/** Per-segment durations (seconds): [intro, ...slides, outro]. */
export function segmentDurations(itemCount: number): number[] {
  return [INTRO_SEC, ...Array.from({ length: itemCount }, () => PER_SLIDE_SEC), OUTRO_SEC];
}

/**
 * Total runtime with xfade overlaps: sum(segments) - (segments-1) * xfade.
 * Each crossfade swallows XFADE_SEC of overlap between adjacent segments.
 */
export function estimateDurationSec(itemCount: number): number {
  const durs = segmentDurations(itemCount);
  const total = durs.reduce((a, b) => a + b, 0) - (durs.length - 1) * XFADE_SEC;
  return Math.round(total * 100) / 100;
}

/** Sanitize a ratio for use in a Blob key (":" → "x"). */
function ratioKey(ratio: SlideshowRatio): string {
  return ratio.replace(":", "x");
}

/** Blob object key a real render writes to. */
export function blobPath(
  brand: SlideshowBrand,
  template: string,
  ratio: SlideshowRatio,
  timestamp: number,
): string {
  return `slideshows/${brand}/${template.toLowerCase()}/${ratioKey(ratio)}/${timestamp}.mp4`;
}

/** Locale for the price/CTA helpers, derived from the config language. */
function localeOf(config: SlideshowConfig): VideoLocale {
  return config.language === "en" ? "en" : "fr";
}

/** Audio dirs a caller-supplied `musicUrl` override is allowed to point inside. */
const ALLOWED_MUSIC_ROOTS = ["public/music", "src/audio"];
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg)$/i;

/**
 * Guard a caller-supplied `musicUrl`. ffmpeg's `-i` natively opens http(s)://,
 * file://, tcp:// etc., so an unvalidated value is an SSRF / arbitrary-file-read
 * sink. Overrides must resolve to a real bundled track under public/music or
 * src/audio — no URL schemes, no traversal, no absolute paths outside those
 * roots. Throws on anything else. `undefined` is fine (the default track is used).
 */
export function assertSafeMusicPath(musicUrl: string | undefined): void {
  if (musicUrl === undefined) return;
  if (typeof musicUrl !== "string" || musicUrl.includes("://")) {
    throw new Error("renderSlideshow: musicUrl must be a local bundled track path, not a URL");
  }
  if (!AUDIO_EXT.test(musicUrl)) {
    throw new Error("renderSlideshow: musicUrl must be an audio file (mp3/m4a/aac/wav/ogg)");
  }
  const root = process.cwd();
  const resolved = path.resolve(root, musicUrl);
  const insideAllowed = ALLOWED_MUSIC_ROOTS.some((rel) => {
    const base = path.resolve(root, rel);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
  if (!insideAllowed) {
    throw new Error(`renderSlideshow: musicUrl must be under ${ALLOWED_MUSIC_ROOTS.join(" or ")}`);
  }
}

/**
 * Build the dry-run manifest: the exact overlay text (post-cleanup), badge
 * decision, and discount for every slide, plus the music + upload target.
 * Pure — no I/O.
 */
export function buildManifest(config: SlideshowConfig, timestamp: number): SlideshowManifest {
  const items: ManifestItem[] = config.items.map((item) => {
    const cleaned = formatVideoTitle(item.overlay_text, 48, { uppercase: false, aggressive: false });
    const showsBadge = shouldShowBadge(item.price, item.compare_at);
    return {
      image_url: item.image_url,
      overlay_text: cleaned,
      price: item.price,
      compare_at: item.compare_at,
      showsBadge,
      discountPct: discountPct(item.price, item.compare_at),
      sku: item.sku,
    };
  });

  const music = config.musicUrl ?? getDefaultMusicTrack();

  return {
    items,
    template: config.template,
    ratio: config.ratio,
    brand: config.brand,
    language: config.language,
    title: config.title,
    music,
    estimatedDurationSec: estimateDurationSec(config.items.length),
    wouldUploadTo: blobPath(config.brand, config.template, config.ratio, timestamp),
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

/**
 * Per-slide overlay SVG: cleaned title, current price, and — only when
 * compare_at >= price * 1.10 — a struck-through compare-at price and a gold
 * discount badge. Sized to the output dimensions.
 */
export function buildSlideOverlaySvg(
  item: SlideshowItem,
  dims: { width: number; height: number },
  locale: VideoLocale,
): string {
  const { gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const title = escapeXml(formatVideoTitle(item.overlay_text, 48, { uppercase: false, aggressive: false }));
  const price = escapeXml(formatPrice(item.price, locale));
  const showBadge = shouldShowBadge(item.price, item.compare_at);
  const pct = discountPct(item.price, item.compare_at);

  const parts: string[] = [
    `<rect x="80" y="120" width="${dims.width - 160}" height="6" fill="${gold}"/>`,
    `<text x="80" y="220" font-family="${font},Arial,sans-serif" font-size="64" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}">${title}</text>`,
    `<text x="80" y="330" font-family="${font},Arial,sans-serif" font-size="88" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}">${price}</text>`,
  ];

  if (showBadge && item.compare_at !== undefined) {
    const was = escapeXml(formatPrice(item.compare_at, locale));
    parts.push(
      `<text x="80" y="400" font-family="${font},Arial,sans-serif" font-size="44" fill="${offWhite}" text-decoration="line-through" opacity="0.75">${was}</text>`,
    );
    if (pct !== undefined) {
      parts.push(
        `<rect x="80" y="430" width="200" height="72" rx="36" fill="${gold}"/>`,
        `<text x="180" y="478" font-family="${font},Arial,sans-serif" font-size="40" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${VIDEO_BRAND.colors.navy}" text-anchor="middle">-${pct}%</text>`,
      );
    }
  }

  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

/** Intro card SVG: store title + slideshow title, centered. */
export function buildIntroCardSvg(
  config: SlideshowConfig,
  dims: { width: number; height: number },
): string {
  const { gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const title = escapeXml(config.title ?? BRAND_STORE_URL[config.brand]);
  const cx = dims.width / 2;
  const cy = dims.height / 2;
  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${cx}" y="${cy - 20}" font-family="${font},Arial,sans-serif" font-size="76" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" text-anchor="middle">${title}</text>
    <rect x="${cx - 120}" y="${cy + 30}" width="240" height="8" fill="${gold}"/>
  </svg>`;
}

/** Outro card SVG: store URL + CTA, centered. */
export function buildOutroCardSvg(
  config: SlideshowConfig,
  dims: { width: number; height: number },
): string {
  const { gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const url = escapeXml(BRAND_STORE_URL[config.brand]);
  const cta = escapeXml(ctaText(localeOf(config)));
  const cx = dims.width / 2;
  const cy = dims.height / 2;
  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${cx}" y="${cy - 20}" font-family="${font},Arial,sans-serif" font-size="84" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}" text-anchor="middle">${url}</text>
    <text x="${cx}" y="${cy + 80}" font-family="${font},Arial,sans-serif" font-size="48" fill="${offWhite}" text-anchor="middle">${cta}</text>
  </svg>`;
}

/**
 * Build the xfade-crossfade `-filter_complex` graph over `count` visual
 * segments (intro + slides + outro), each a still looped to its duration and
 * Ken-Burns zoomed, plus optional faded music. Pure — unit-testable.
 *
 * Inputs are ordered [0..count-1] segments, then music (if any).
 */
export function buildXfadeFilterComplex(opts: {
  count: number;
  durations: number[];
  dims: { width: number; height: number };
  fps?: number;
  xfadeSec?: number;
  hasMusic: boolean;
  musicVolumeDb: number;
  totalSec: number;
}): { filterComplex: string; videoLabel: string; audioLabel: string | null } {
  const fps = opts.fps ?? FPS;
  const x = opts.xfadeSec ?? XFADE_SEC;
  const { width: w, height: h } = opts.dims;
  const parts: string[] = [];

  // Each segment: scale/pad to frame, Ken Burns zoom, normalize sar/fps/format.
  for (let i = 0; i < opts.count; i++) {
    const frames = Math.round(opts.durations[i] * fps);
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x1A2340,` +
        `zoompan=z='min(zoom+0.0012,1.4)':d=${frames}:s=${w}x${h}:fps=${fps}` +
        `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',setsar=1,format=yuv420p[v${i}]`,
    );
  }

  // Chain xfades. offset_i = sum(dur[0..i]) - (i+1)*x.
  let prev = "v0";
  let cumulative = 0;
  for (let i = 1; i < opts.count; i++) {
    cumulative += opts.durations[i - 1];
    const offset = Math.max(0, Math.round((cumulative - i * x) * 1000) / 1000);
    const out = i === opts.count - 1 ? "vout" : `xf${i}`;
    parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${x}:offset=${offset}[${out}]`);
    prev = out;
  }
  // Single-segment edge case: no xfade, expose v0 directly.
  const videoLabel = opts.count <= 1 ? "v0" : "vout";

  let audioLabel: string | null = null;
  if (opts.hasMusic) {
    const musicIdx = opts.count; // music input follows the segments
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

// ─── I/O + render ────────────────────────────────────────────────────────

function getWorkDir(): string {
  const base = process.env.VERCEL
    ? path.join("/tmp", "slideshow")
    : path.join(process.cwd(), "public", "social-videos", ".work");
  const dir = path.join(base, `slideshow-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

/** Render an SVG-overlaid slide PNG from a downloaded product image. */
async function renderSlidePng(
  item: SlideshowItem,
  dims: { width: number; height: number },
  locale: VideoLocale,
  outPath: string,
): Promise<void> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);

  let base: import("sharp").Sharp;
  try {
    // Defense in depth: validateSlideshowConfig already enforces this, but never
    // hand a non-Shopify-CDN URL to the downloader (Aosom CDN 403s; arbitrary
    // hosts are an SSRF surface). isShopifyCdnUrl is the same gate as validation.
    if (!isShopifyCdnUrl(item.image_url)) {
      throw new Error(`refusing to fetch non-cdn.shopify.com image: ${item.image_url}`);
    }
    const buf = await downloadImage(item.image_url);
    base = sharpFn(buf).resize(dims.width, dims.height, { fit: "contain", background: navy }).flatten({ background: navy });
  } catch {
    base = sharpFn({ create: { width: dims.width, height: dims.height, channels: 3, background: navy } });
  }
  const overlay = Buffer.from(buildSlideOverlaySvg(item, dims, locale));
  await base.composite([{ input: overlay, top: 0, left: 0 }]).png().toFile(outPath);
}

/** Render a full-frame card PNG (navy background + the given SVG overlay). */
async function renderCardPng(svg: string, dims: { width: number; height: number }, outPath: string): Promise<void> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);
  await sharpFn({ create: { width: dims.width, height: dims.height, channels: 3, background: navy } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outPath);
}

/**
 * Render a slideshow.
 *
 * dryRun → returns { manifest } describing the render, writing nothing.
 * Otherwise → renders the MP4, uploads it to the PUBLIC Vercel Blob store, and
 * returns { blobUrl }. Throws on an invalid config or a missing Blob token.
 */
export async function renderSlideshow(config: SlideshowConfig): Promise<SlideshowResult> {
  const validation = validateSlideshowConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid slideshow config: ${validation.errors.join("; ")}`);
  }
  // musicUrl isn't part of the pure config validation (it needs path resolution);
  // gate it here so neither the dry-run manifest nor a real render trusts a URL.
  assertSafeMusicPath(config.musicUrl);

  const timestamp = Date.now();

  if (config.dryRun) {
    const manifest = buildManifest(config, timestamp);
    return { manifest, durationSec: manifest.estimatedDurationSec };
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("renderSlideshow: BLOB_READ_WRITE_TOKEN is required for a real render (public store)");
  }

  const dims = ratioDimensions(config.ratio);
  const locale = localeOf(config);
  const durations = segmentDurations(config.items.length);
  const totalSec = estimateDurationSec(config.items.length);
  const workDir = getWorkDir();

  try {
    // 1. Intro card, slides, outro card (in segment order).
    const introPath = path.join(workDir, "intro.png");
    const outroPath = path.join(workDir, "outro.png");
    await renderCardPng(buildIntroCardSvg(config, dims), dims, introPath);
    const slidePaths: string[] = [];
    for (let i = 0; i < config.items.length; i++) {
      const p = path.join(workDir, `slide-${i}.png`);
      await renderSlidePng(config.items[i], dims, locale, p);
      slidePaths.push(p);
    }
    await renderCardPng(buildOutroCardSvg(config, dims), dims, outroPath);
    const segmentPaths = [introPath, ...slidePaths, outroPath];

    // 2. Music (config override → bundled royalty-free default → silent).
    const musicPath = config.musicUrl ?? getDefaultMusicTrack();

    // 3. ffmpeg arg vector: each segment looped to its duration, then xfade.
    const args: string[] = [];
    segmentPaths.forEach((p, i) => {
      args.push("-loop", "1", "-t", String(durations[i]), "-i", p);
    });
    if (musicPath) args.push("-i", musicPath);

    const { filterComplex, videoLabel, audioLabel } = buildXfadeFilterComplex({
      count: segmentPaths.length,
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

    // 4. Upload to the PUBLIC Vercel Blob store (Meta/YouTube fetch the URL).
    const { put } = await import("@vercel/blob");
    const buffer = await fs.promises.readFile(outPath);
    const blob = await put(blobPath(config.brand, config.template, config.ratio, timestamp), buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return { blobUrl: blob.url, durationSec: totalSec };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* leave temp files rather than fail the render */
    }
  }
}
