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
/** Ken Burns zoom rate per frame and zoom bounds (shared by zoom-in/out variants). */
const KB_ZOOM_INC = 0.0022;
const KB_ZOOM_MAX = 1.5;
const KB_ZOOM_MIN = 1.0;

/** Rotate through XFADE_TRANSITIONS by index (shared by transitionsFor + the fallback). */
function rotatedTransition(index: number): string {
  return XFADE_TRANSITIONS[index % XFADE_TRANSITIONS.length];
}

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
  return Array.from({ length: junctions }, (_, i) => rotatedTransition(i));
}

/**
 * Ken Burns zoompan expression for segment `index`: alternates zoom-in / zoom-out
 * and rotates the pan anchor through the four corners, so consecutive slides move
 * differently instead of all zooming into the centre.
 *
 * The zoom is a PURE function of the output-frame counter `on` (0-indexed), not the
 * `zoom` accumulator — so zoom-out starts at KB_ZOOM_MAX on frame 0 (no first-frame
 * pop from the accumulator's 1.0 init), and both directions are deterministic.
 */
export function kenBurnsExpr(index: number): { z: string; x: string; y: string } {
  const zoomIn = index % 2 === 0;
  const z = zoomIn
    ? `min(${KB_ZOOM_MIN}+${KB_ZOOM_INC}*on,${KB_ZOOM_MAX})`
    : `max(${KB_ZOOM_MAX}-${KB_ZOOM_INC}*on,${KB_ZOOM_MIN})`;
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

  // Dry-run preview only: shows the DEFAULT track. A real render rotates via
  // pickMusicTrack(), so the shipped track may differ (unless musicUrl pins one).
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
  storeUrl: string = BRAND_STORE_URL.ameublo,
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
 * Intro-card background: the first product photo (cdn.shopify) for non-lifestyle
 * series, or null when the opener is a hero (lifestyle keeps its navy card) or the
 * first item has no usable Shopify photo. Pure — unit-testable.
 */
export function introBackgroundUrl(items: SlideshowItem[]): string | null {
  const first = items[0];
  return first && !first.hero && isShopifyCdnUrl(first.image_url) ? first.image_url : null;
}

/**
 * Build the xfade-crossfade `-filter_complex` graph over `count` visual
 * segments (intro + slides + outro). Each segment has a photo layer (Ken-Burns
 * zoomed) and a static transparent text layer overlaid on top, plus optional
 * faded music. Pure — unit-testable.
 *
 * Inputs are ordered [0..count-1] photo layers, then [count..2*count-1] text
 * layers, then music (if any).
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
  const transAt = (j: number): string => opts.transitions?.[j] ?? rotatedTransition(j);
  const parts: string[] = [];

  // Two inputs per segment: the product/photo layer [i] and a transparent text
  // layer [count+i] (scrim + title + price + CTA). Ken Burns (alternating zoom
  // in/out + rotating pan anchor) animates ONLY the photo; the text is overlaid
  // static on top so titles/prices never scale, pan, or crop off-frame.
  for (let i = 0; i < opts.count; i++) {
    const frames = Math.round(opts.durations[i] * fps);
    const kb = kenBurnsExpr(i);
    const textIdx = opts.count + i;
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x1A2340,` +
        `zoompan=z='${kb.z}':d=${frames}:s=${w}x${h}:fps=${fps}` +
        `:x='${kb.x}':y='${kb.y}',setsar=1[p${i}]`,
    );
    parts.push(`[${textIdx}:v]scale=${w}:${h},setsar=1,format=rgba[t${i}]`);
    parts.push(`[p${i}][t${i}]overlay=0:0:format=auto,format=yuv420p[v${i}]`);
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
    const musicIdx = 2 * opts.count; // music input follows the photo + text layers
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

type Dims = { width: number; height: number };
/** A rendered segment = a photo layer (Ken-Burns zoomed) + a static text layer. */
type SegmentLayers = { photoPath: string; textPath: string };

/** Write the transparent text-overlay layer (scrim + title/price/CTA) as a PNG. */
async function writeTextLayer(svg: string, outPath: string): Promise<void> {
  const sharpFn = (await import("sharp")).default;
  await sharpFn(Buffer.from(svg)).png().toFile(outPath);
}

/** Write a full-frame solid-navy PNG (photo layer for cards with no photo). */
async function writeNavyLayer(dims: Dims, outPath: string): Promise<void> {
  const sharpFn = (await import("sharp")).default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);
  await sharpFn({ create: { width: dims.width, height: dims.height, channels: 3, background: navy } })
    .png()
    .toFile(outPath);
}

/**
 * Render a product slide's two layers: the photo (contained/cover on navy, no
 * text — this is what Ken Burns zooms) and the transparent text overlay (scrim +
 * title + price + CTA, held static on top so it never scales or pans off-frame).
 */
async function renderSlideLayers(
  item: SlideshowItem,
  dims: Dims,
  locale: VideoLocale,
  layers: SegmentLayers,
  storeUrl: string,
): Promise<void> {
  const sharpFn = (await import("sharp")).default;
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
  await base.png().toFile(layers.photoPath);
  await writeTextLayer(buildSlideOverlaySvg(item, dims, locale, storeUrl), layers.textPath);
}

/** Render an outro (or any navy) card as photo (navy) + text overlay layers. */
async function renderCardLayers(svg: string, dims: Dims, layers: SegmentLayers): Promise<void> {
  await writeNavyLayer(dims, layers.photoPath);
  await writeTextLayer(svg, layers.textPath);
}

/**
 * Render the intro card's two layers. For non-lifestyle series (the first item is
 * a product, not a hero) the first product photo becomes the photo layer (cover)
 * under a navy scrim + hook; otherwise the photo layer is plain navy. The hook
 * text is always the static overlay. Falls back to navy on any download failure.
 */
async function renderIntroLayers(
  config: SlideshowConfig,
  dims: Dims,
  bgImageUrl: string | null,
  layers: SegmentLayers,
): Promise<void> {
  const sharpFn = (await import("sharp")).default;
  let hasBg = false;
  if (bgImageUrl) {
    try {
      const buf = await downloadImage(bgImageUrl);
      await sharpFn(buf).resize(dims.width, dims.height, { fit: "cover" }).png().toFile(layers.photoPath);
      hasBg = true;
    } catch {
      // Unreachable photo → fall back to the plain navy intro photo layer.
    }
  }
  if (!hasBg) await writeNavyLayer(dims, layers.photoPath);
  await writeTextLayer(buildIntroCardSvg(config, dims, hasBg), layers.textPath);
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
    // 1. Each segment renders two layers: a photo (Ken-Burns zoomed) and a static
    // text overlay. Intro: non-lifestyle series (first item is a product, not a
    // hero) use the first product photo as the intro photo layer (cover + navy
    // scrim) instead of plain navy. Outro: navy card.
    const layerFor = (name: string): SegmentLayers => ({
      photoPath: path.join(workDir, `${name}.photo.png`),
      textPath: path.join(workDir, `${name}.text.png`),
    });
    const introBgUrl = introBackgroundUrl(config.items);
    const segmentLayers: SegmentLayers[] = [];
    const intro = layerFor("intro");
    await renderIntroLayers(config, dims, introBgUrl, intro);
    segmentLayers.push(intro);
    for (let i = 0; i < config.items.length; i++) {
      const slide = layerFor(`slide-${i}`);
      await renderSlideLayers(config.items[i], dims, locale, slide, storeUrl);
      segmentLayers.push(slide);
    }
    const outro = layerFor("outro");
    await renderCardLayers(buildOutroCardSvg(config, dims), dims, outro);
    segmentLayers.push(outro);

    // 2. Music: config override → a rotated bundled royalty-free track → silent.
    const musicPath = config.musicUrl ?? pickMusicTrack();

    // 3. ffmpeg arg vector: photo layers, then text layers (each looped to its
    // segment duration), then music — the input order buildXfadeFilterComplex expects.
    const args: string[] = [];
    segmentLayers.forEach((s, i) => {
      args.push("-loop", "1", "-t", String(durations[i]), "-i", s.photoPath);
    });
    segmentLayers.forEach((s, i) => {
      args.push("-loop", "1", "-t", String(durations[i]), "-i", s.textPath);
    });
    if (musicPath) args.push("-i", musicPath);

    const { filterComplex, videoLabel, audioLabel } = buildXfadeFilterComplex({
      count: segmentLayers.length,
      durations,
      dims,
      xfadeSec: effXfade,
      transitions: transitionsFor(config.template, segmentLayers.length),
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
