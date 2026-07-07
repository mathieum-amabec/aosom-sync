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
import { registerBrandFonts } from "@/lib/register-brand-fonts";
import { VIDEO_BRAND } from "@/lib/video-brand-tokens";
import { formatVideoTitle } from "@/lib/video-title-utils";
import {
  resolveFfmpegPath,
  formatPrice,
  ctaText,
  type VideoLocale,
} from "@/lib/video-engines/ffmpeg-slideshow";
import { getDefaultMusicTrack, pickMusicTrack } from "./music";
import { validateSlideshowConfig, shouldShowBadge, discountPct, isShopifyCdnUrl, isHeroImageUrl } from "./validate";
import {
  SlideshowTemplate,
  type SlideshowConfig,
  type SlideshowItem,
  type SlideshowResult,
  type SlideshowManifest,
  type ManifestItem,
  type SlideshowRatio,
  type SlideshowBrand,
} from "./types";

// SVG text is rendered by librsvg/fontconfig (not Sharp's fontfile), so register
// the bundled DM Sans + Noto Emoji before the first slide/card renders — otherwise
// titles + the CTA emoji render as tofu boxes on the Linux render host.
registerBrandFonts();

const FPS = 30;
const INTRO_SEC = 1.2;
const OUTRO_SEC = 1.3;
const PER_SLIDE_SEC = 2.4;
/** Bounds for the per-slide hold when a target duration is requested. */
const PER_SLIDE_MIN = 1.5;
const PER_SLIDE_MAX = 4;
const XFADE_SEC = 0.28;
/** Hard-cut series (urgency / price-drop) use a near-zero crossfade — a visual cut,
 * kept inside the xfade graph so segment offsets/timing stay uniform. */
const HARD_CUT_SEC = 0.04;
const MUSIC_FADE_IN_SEC = 0.3;
const MUSIC_FADE_OUT_SEC = 2;
const RENDER_TIMEOUT_MS = 5 * 60_000;

/** Rotated xfade transitions for slide junctions (dynamic pacing, not a flat fade). */
export const XFADE_TRANSITIONS = ["slideleft", "smoothleft", "wiperight", "zoomin"] as const;
/** Templates that get hard cuts (punchy scarcity/deal energy) instead of crossfades. */
const HARD_CUT_TEMPLATES: ReadonlySet<SlideshowTemplate> = new Set([
  SlideshowTemplate.URGENCY,
  SlideshowTemplate.PRICE_DROP,
]);
/** Ken Burns zoom rate per frame and zoom cap (shared by zoom-in/out variants). */
const KB_ZOOM_INC = 0.0022;
const KB_ZOOM_MAX = 1.5;

/** Effective crossfade duration for a template: a hard cut for urgency/price-drop. */
export function xfadeSecFor(template: SlideshowTemplate): number {
  return HARD_CUT_TEMPLATES.has(template) ? HARD_CUT_SEC : XFADE_SEC;
}

/**
 * Per-junction transition name for `count` segments (intro + slides + outro).
 * Hard-cut templates get `fade` at the near-zero HARD_CUT_SEC (a clean cut);
 * others rotate through XFADE_TRANSITIONS so no two adjacent joins look identical.
 */
export function transitionsFor(template: SlideshowTemplate, count: number): string[] {
  const junctions = Math.max(0, count - 1);
  if (HARD_CUT_TEMPLATES.has(template)) return Array.from({ length: junctions }, () => "fade");
  return Array.from({ length: junctions }, (_, i) => XFADE_TRANSITIONS[i % XFADE_TRANSITIONS.length]);
}

/**
 * Ken Burns zoompan expression for segment `index`: alternates zoom-in / zoom-out
 * and rotates the pan anchor through the four corners, so consecutive slides move
 * differently instead of all zooming into the centre.
 */
export function kenBurnsExpr(index: number): { z: string; x: string; y: string } {
  const zoomIn = index % 2 === 0;
  const z = zoomIn
    ? `min(zoom+${KB_ZOOM_INC},${KB_ZOOM_MAX})`
    : `if(eq(on,1),${KB_ZOOM_MAX},max(zoom-${KB_ZOOM_INC},1.0))`;
  // Pan anchors: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right.
  const corner = index % 4;
  const left = corner === 0 || corner === 2;
  const top = corner === 0 || corner === 1;
  const x = left ? "0" : "iw-iw/zoom";
  const y = top ? "0" : "ih-ih/zoom";
  return { z, x, y };
}

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

/**
 * Per-slide hold (seconds). Default is the fixed PER_SLIDE_SEC pacing; when a
 * `targetDurationSec` is requested, the hold is solved so the total runtime lands
 * on the target (intro/outro and the xfade overlaps held constant), then clamped
 * to a watchable range. A target the clamp can't reach yields the nearest pacing.
 */
export function perSlideSeconds(itemCount: number, targetDurationSec?: number, xfadeSec: number = XFADE_SEC): number {
  if (!targetDurationSec || itemCount <= 0) return PER_SLIDE_SEC;
  // total = INTRO + OUTRO + N*perSlide - (N+1)*xfade  ⇒  solve for perSlide.
  const perSlide = (targetDurationSec - INTRO_SEC - OUTRO_SEC + (itemCount + 1) * xfadeSec) / itemCount;
  return Math.min(PER_SLIDE_MAX, Math.max(PER_SLIDE_MIN, perSlide));
}

/** Per-segment durations (seconds): [intro, ...slides, outro]. */
export function segmentDurations(itemCount: number, targetDurationSec?: number, xfadeSec: number = XFADE_SEC): number[] {
  const perSlide = perSlideSeconds(itemCount, targetDurationSec, xfadeSec);
  return [INTRO_SEC, ...Array.from({ length: itemCount }, () => perSlide), OUTRO_SEC];
}

/**
 * Total runtime with xfade overlaps: sum(segments) - (segments-1) * xfade.
 * Each crossfade swallows XFADE_SEC of overlap between adjacent segments. Returns
 * the ACTUAL runtime (after per-slide clamping), which may differ slightly from a
 * requested target.
 */
export function estimateDurationSec(itemCount: number, targetDurationSec?: number, xfadeSec: number = XFADE_SEC): number {
  const durs = segmentDurations(itemCount, targetDurationSec, xfadeSec);
  const total = durs.reduce((a, b) => a + b, 0) - (durs.length - 1) * xfadeSec;
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
    estimatedDurationSec: estimateDurationSec(config.items.length, config.targetDurationSec, xfadeSecFor(config.template)),
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
 * Wrap a (already-shortened) title onto at most 2 lines, breaking on the word
 * boundary nearest `maxPerLine` chars so a long mobile title doesn't overflow.
 */
export function wrapTitle(text: string, maxPerLine = 16): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const line1: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    const next = [...line1, words[i]].join(" ");
    if (line1.length > 0 && next.length > maxPerLine) break;
    line1.push(words[i]);
  }
  const line2 = words.slice(i).join(" ");
  return line2 ? [line1.join(" "), line2] : [line1.join(" ")];
}

/**
 * Greedily wrap text into up to `maxLines` lines, each ≤ `maxPerLine` chars
 * (every line is bounded, unlike wrapTitle whose 2nd line is the unbounded
 * remainder). Used for the intro hook, which can be a long clickbait line or a
 * Claude slogan — keeps it from clipping the frame edges.
 */
export function wrapLines(text: string, maxPerLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? `${cur} ${w}` : w;
    if (cur && next.length > maxPerLine) {
      lines.push(cur);
      if (lines.length === maxLines - 1) {
        // Last allowed line takes all remaining words as-is.
        cur = words.slice(i).join(" ");
        break;
      }
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Intro font sized so the longest wrapped line fits the frame width (no clipping). */
function introFontSize(lines: string[]): number {
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest <= 16) return 92;
  if (longest <= 20) return 80;
  if (longest <= 26) return 68;
  return 58;
}

/**
 * Per-slide overlay SVG: cleaned 1-2 line title (≤28 chars, mobile-sized),
 * current price, and — only when compare_at >= price * 1.10 — a struck-through
 * compare-at price and a gold discount badge. A `hero` item renders its text big
 * and centered with no price (lifestyle/Unsplash opening slide).
 */
export function buildSlideOverlaySvg(
  item: SlideshowItem,
  dims: { width: number; height: number },
  locale: VideoLocale,
  storeUrl: string = "ameublodirect.ca",
): string {
  const { navy, gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;

  // Hero (lifestyle opener): big centered hook text on the image, no price/badge.
  if (item.hero) {
    const heroLines = wrapTitle(item.overlay_text, 22);
    const cx = dims.width / 2;
    const cy = dims.height / 2;
    const gap = 92;
    const top = cy - ((heroLines.length - 1) * gap) / 2;
    const heroParts = heroLines.map(
      (ln, i) =>
        `<text x="${cx}" y="${top + i * gap}" font-family="${font},Arial,sans-serif" font-size="80" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" text-anchor="middle" stroke="${VIDEO_BRAND.colors.navy}" stroke-width="2">${escapeXml(ln)}</text>`,
    );
    return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">${heroParts.join("")}</svg>`;
  }

  // Title: cap at 28 chars (mobile), wrap to ≤2 lines, font −10% (64 → 58).
  const cleaned = formatVideoTitle(item.overlay_text, 28, { uppercase: false, aggressive: false });
  const lines = wrapTitle(cleaned, 16);
  const titleFs = 58;
  const lineGap = 66;
  const titleTop = 200;
  const price = escapeXml(formatPrice(item.price, locale));
  const showBadge = shouldShowBadge(item.price, item.compare_at);
  const pct = discountPct(item.price, item.compare_at);

  const priceY = titleTop + lines.length * lineGap + 44;
  // Semi-transparent navy scrim behind the title + price block so the text stays
  // legible over any product photo (mirrors the hero readability, which had none).
  const scrimTop = 96;
  const scrimBottom = priceY + (showBadge ? 190 : 40);
  const parts: string[] = [
    `<rect x="40" y="${scrimTop}" width="${dims.width - 80}" height="${scrimBottom - scrimTop}" rx="28" fill="${navy}" opacity="0.55"/>`,
    `<rect x="80" y="120" width="${dims.width - 160}" height="6" fill="${gold}"/>`,
  ];
  // Title: navy stroke + drop shadow, same legibility treatment the hero already had.
  lines.forEach((ln, i) => {
    parts.push(
      `<text x="80" y="${titleTop + i * lineGap}" font-family="${font},Arial,sans-serif" font-size="${titleFs}" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" stroke="${navy}" stroke-width="2" paint-order="stroke">${escapeXml(ln)}</text>`,
    );
  });
  parts.push(
    `<text x="80" y="${priceY}" font-family="${font},Arial,sans-serif" font-size="88" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}" stroke="${navy}" stroke-width="2" paint-order="stroke">${price}</text>`,
  );

  if (showBadge && item.compare_at !== undefined) {
    const was = escapeXml(formatPrice(item.compare_at, locale));
    parts.push(
      `<text x="80" y="${priceY + 70}" font-family="${font},Arial,sans-serif" font-size="44" fill="${offWhite}" text-decoration="line-through" opacity="0.85">${was}</text>`,
    );
    if (pct !== undefined) {
      parts.push(
        `<rect x="80" y="${priceY + 100}" width="200" height="72" rx="36" fill="${gold}"/>`,
        `<text x="180" y="${priceY + 148}" font-family="${font},Arial,sans-serif" font-size="40" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${navy}" text-anchor="middle">-${pct}%</text>`,
      );
    }
  }

  // Persistent, discreet CTA pill bottom-centre: the store URL on a navy pill so
  // every product slide carries the destination even mid-scroll.
  const cx = dims.width / 2;
  const pillW = 460;
  const pillY = dims.height - 150;
  parts.push(
    `<rect x="${cx - pillW / 2}" y="${pillY}" width="${pillW}" height="72" rx="36" fill="${navy}" opacity="0.72"/>`,
    `<text x="${cx}" y="${pillY + 48}" font-family="${font},Arial,sans-serif" font-size="36" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}" text-anchor="middle" letter-spacing="1">${escapeXml(storeUrl)}</text>`,
  );

  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

/**
 * Intro card SVG: the marketing HOOK in large type (config.title carries the
 * hook, never a technical series id), wrapped to ≤3 lines with EVERY line bounded
 * (≤18 chars) and the font auto-sized so the longest line never clips the frame.
 */
export function buildIntroCardSvg(
  config: SlideshowConfig,
  dims: { width: number; height: number },
  hasBgImage: boolean = false,
): string {
  const { navy, gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const hookLines = wrapLines(config.title ?? BRAND_STORE_URL[config.brand], 18, 3);
  const fs = introFontSize(hookLines);
  const gap = Math.round(fs * 1.18);
  const cx = dims.width / 2;
  const cy = dims.height / 2;
  const top = cy - 30 - ((hookLines.length - 1) * gap) / 2;
  // Over a product photo, add a full-frame navy scrim + a text stroke so the hook
  // reads; over the plain navy card neither is needed.
  const scrim = hasBgImage
    ? `<rect x="0" y="0" width="${dims.width}" height="${dims.height}" fill="${navy}" opacity="0.5"/>`
    : "";
  const strokeAttr = hasBgImage ? ` stroke="${navy}" stroke-width="3" paint-order="stroke"` : "";
  const lines = hookLines.map(
    (ln, i) =>
      `<text x="${cx}" y="${top + i * gap}" font-family="${font},Arial,sans-serif" font-size="${fs}" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" text-anchor="middle"${strokeAttr}>${escapeXml(ln)}</text>`,
  );
  const ruleY = top + hookLines.length * gap;
  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    ${scrim}${lines.join("")}
    <rect x="${cx - 120}" y="${ruleY}" width="240" height="8" fill="${gold}"/>
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
  /** Per-junction transition names (length count-1). Defaults to the rotation. */
  transitions?: string[];
  hasMusic: boolean;
  musicVolumeDb: number;
  totalSec: number;
  musicFadeInSec?: number;
}): { filterComplex: string; videoLabel: string; audioLabel: string | null } {
  const fps = opts.fps ?? FPS;
  const x = opts.xfadeSec ?? XFADE_SEC;
  const musicFadeIn = opts.musicFadeInSec ?? MUSIC_FADE_IN_SEC;
  const { width: w, height: h } = opts.dims;
  const transAt = (j: number): string => opts.transitions?.[j] ?? XFADE_TRANSITIONS[j % XFADE_TRANSITIONS.length];
  const parts: string[] = [];

  // Each segment: scale/pad to frame, per-segment Ken Burns (alternating zoom
  // in/out + rotating pan anchor), normalize sar/fps/format.
  for (let i = 0; i < opts.count; i++) {
    const frames = Math.round(opts.durations[i] * fps);
    const kb = kenBurnsExpr(i);
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x1A2340,` +
        `zoompan=z='${kb.z}':d=${frames}:s=${w}x${h}:fps=${fps}` +
        `:x='${kb.x}':y='${kb.y}',setsar=1,format=yuv420p[v${i}]`,
    );
  }

  // Chain xfades with rotating transitions. offset_i = sum(dur[0..i]) - (i+1)*x.
  let prev = "v0";
  let cumulative = 0;
  for (let i = 1; i < opts.count; i++) {
    cumulative += opts.durations[i - 1];
    const offset = Math.max(0, Math.round((cumulative - i * x) * 1000) / 1000);
    const out = i === opts.count - 1 ? "vout" : `xf${i}`;
    parts.push(`[${prev}][v${i}]xfade=transition=${transAt(i - 1)}:duration=${x}:offset=${offset}[${out}]`);
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
        `afade=t=in:st=0:d=${musicFadeIn},` +
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
  storeUrl: string,
): Promise<void> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);

  let base: import("sharp").Sharp;
  try {
    // Defense in depth: validateSlideshowConfig already enforces this, but never
    // hand an unexpected host to the downloader (Aosom CDN 403s; arbitrary hosts
    // are an SSRF surface). Product slides: cdn.shopify only; hero slides also
    // allow Unsplash — the same gate as validation.
    const ok = item.hero ? isHeroImageUrl(item.image_url) : isShopifyCdnUrl(item.image_url);
    if (!ok) {
      throw new Error(`refusing to fetch disallowed image host: ${item.image_url}`);
    }
    const buf = await downloadImage(item.image_url);
    // Hero fills the frame (full-bleed lifestyle); product photos are contained.
    base = item.hero
      ? sharpFn(buf).resize(dims.width, dims.height, { fit: "cover" })
      : sharpFn(buf).resize(dims.width, dims.height, { fit: "contain", background: navy }).flatten({ background: navy });
  } catch {
    base = sharpFn({ create: { width: dims.width, height: dims.height, channels: 3, background: navy } });
  }
  const overlay = Buffer.from(buildSlideOverlaySvg(item, dims, locale, storeUrl));
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
 * Render the intro card. For non-lifestyle series (the first item is a product,
 * not a hero) the first product photo becomes the card background (cover) with a
 * navy scrim + the hook over it, instead of the plain navy card. Falls back to the
 * navy card on any download failure or when no product photo is available.
 */
async function renderIntroCardPng(
  config: SlideshowConfig,
  dims: { width: number; height: number },
  bgImageUrl: string | null,
  outPath: string,
): Promise<void> {
  if (!bgImageUrl) {
    await renderCardPng(buildIntroCardSvg(config, dims, false), dims, outPath);
    return;
  }
  const sharpFn = (await import("sharp")).default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);
  let base: import("sharp").Sharp;
  try {
    const buf = await downloadImage(bgImageUrl);
    base = sharpFn(buf).resize(dims.width, dims.height, { fit: "cover" });
  } catch {
    // Unreachable photo → fall back to the plain navy intro card.
    await renderCardPng(buildIntroCardSvg(config, dims, false), dims, outPath);
    return;
  }
  const overlay = Buffer.from(buildIntroCardSvg(config, dims, true));
  await base.composite([{ input: overlay, top: 0, left: 0 }]).png().toFile(outPath);
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
  const storeUrl = BRAND_STORE_URL[config.brand];
  const effXfade = xfadeSecFor(config.template);
  const durations = segmentDurations(config.items.length, config.targetDurationSec, effXfade);
  const totalSec = estimateDurationSec(config.items.length, config.targetDurationSec, effXfade);
  const workDir = getWorkDir();

  try {
    // 1. Intro card, slides, outro card (in segment order). Non-lifestyle series
    // (the first item is a product, not a hero) use the first product photo as the
    // intro background (cover + navy scrim) instead of a plain navy card.
    const introPath = path.join(workDir, "intro.png");
    const outroPath = path.join(workDir, "outro.png");
    const first = config.items[0];
    const introBgUrl = first && !first.hero && isShopifyCdnUrl(first.image_url) ? first.image_url : null;
    await renderIntroCardPng(config, dims, introBgUrl, introPath);
    const slidePaths: string[] = [];
    for (let i = 0; i < config.items.length; i++) {
      const p = path.join(workDir, `slide-${i}.png`);
      await renderSlidePng(config.items[i], dims, locale, p, storeUrl);
      slidePaths.push(p);
    }
    await renderCardPng(buildOutroCardSvg(config, dims), dims, outroPath);
    const segmentPaths = [introPath, ...slidePaths, outroPath];

    // 2. Music: config override → a rotated bundled royalty-free track → silent.
    const musicPath = config.musicUrl ?? pickMusicTrack();

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
      xfadeSec: effXfade,
      transitions: transitionsFor(config.template, segmentPaths.length),
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
