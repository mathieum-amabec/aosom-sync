/**
 * Image-carousel renderer (Module E).
 *
 * renderCarousel turns a validated CarouselConfig into either:
 *   - a dry-run MANIFEST (dryRun:true) — what each card would show, with NO
 *     image download, NO Sharp, NO Blob write; or
 *   - one branded PNG per item, uploaded to the PUBLIC Vercel Blob store,
 *     returning the URLs in slide order.
 *
 * Each card: the product photo (Shopify CDN, SSRF-guarded download) resized to
 * the format on a navy field, with an SVG overlay (cleaned title, price, and a
 * gold discount badge when compare_at >= price * 1.10) and the store logo in the
 * bottom-right. Shares the slideshow's CDN/title/badge rules via validate.ts.
 */
import path from "path";
import fs from "fs";
import { downloadImage } from "@/lib/image-composer";
import { registerBrandFonts } from "@/lib/register-brand-fonts";
import { VIDEO_BRAND } from "@/lib/video-brand-tokens";
import { formatVideoTitle } from "@/lib/video-title-utils";
import { formatPrice, type VideoLocale } from "@/lib/video-engines/ffmpeg-slideshow";
import { isShopifyCdnUrl, shouldShowBadge, discountPct } from "@/lib/slideshow/validate";
import type { SlideshowItem, SlideshowBrand } from "@/lib/slideshow/types";
import type {
  CarouselConfig,
  CarouselFormat,
  CarouselManifest,
  CarouselManifestItem,
  CarouselResult,
} from "./types";

// SVG text is rendered by librsvg/fontconfig (not Sharp's fontfile), so register
// the bundled DM Sans before the first card or titles render as tofu on Linux.
registerBrandFonts();

/** Pixel dimensions for a carousel format. */
export function carouselDimensions(format: CarouselFormat): { width: number; height: number } {
  return format === "1080x1350" ? { width: 1080, height: 1350 } : { width: 1080, height: 1080 };
}

/** Blob object key for card `index` of a carousel render. */
export function carouselBlobPath(
  brand: SlideshowBrand,
  format: CarouselFormat,
  timestamp: number,
  index: number,
): string {
  return `slideshows/${brand}/carousel/${format}/${timestamp}/${index}.png`;
}

/** Locale for the price helper, derived from the config language. */
function localeOf(config: CarouselConfig): VideoLocale {
  return config.language === "en" ? "en" : "fr";
}

/** Store logo (repo-relative) for a brand: ameublo → FR logo, furnish → EN logo. */
function brandLogoLocale(brand: SlideshowBrand): "fr" | "en" {
  return brand === "furnish" ? "en" : "fr";
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
 * Per-card overlay SVG: a bottom scrim, the cleaned title, current price, and —
 * only when compare_at >= price * 1.10 — a struck-through compare-at and a gold
 * "-N%" badge. Sized to the output dimensions. Pure — unit-tested without Sharp.
 */
export function buildCarouselOverlaySvg(
  item: SlideshowItem,
  dims: { width: number; height: number },
  locale: VideoLocale,
): string {
  const { navy, gold, offWhite } = VIDEO_BRAND.colors;
  const font = VIDEO_BRAND.font.family;
  const title = escapeXml(formatVideoTitle(item.overlay_text, 40, { uppercase: false, aggressive: false }));
  const price = escapeXml(formatPrice(item.price, locale));
  const showBadge = shouldShowBadge(item.price, item.compare_at);
  const pct = discountPct(item.price, item.compare_at);

  const scrimTop = dims.height - 360;
  const parts: string[] = [
    // Bottom scrim so text stays legible over any photo.
    `<rect x="0" y="${scrimTop}" width="${dims.width}" height="360" fill="${navy}" opacity="0.82"/>`,
    `<rect x="80" y="${scrimTop + 56}" width="${dims.width - 160}" height="6" fill="${gold}"/>`,
    `<text x="80" y="${scrimTop + 150}" font-family="${font},Arial,sans-serif" font-size="52" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${offWhite}">${title}</text>`,
    `<text x="80" y="${scrimTop + 250}" font-family="${font},Arial,sans-serif" font-size="80" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${gold}">${price}</text>`,
  ];

  if (showBadge && item.compare_at !== undefined) {
    const was = escapeXml(formatPrice(item.compare_at, locale));
    parts.push(
      `<text x="430" y="${scrimTop + 250}" font-family="${font},Arial,sans-serif" font-size="40" fill="${offWhite}" text-decoration="line-through" opacity="0.75">${was}</text>`,
    );
    if (pct !== undefined) {
      parts.push(
        `<rect x="${dims.width - 280}" y="${scrimTop + 60}" width="200" height="84" rx="42" fill="${gold}"/>`,
        `<text x="${dims.width - 180}" y="${scrimTop + 116}" font-family="${font},Arial,sans-serif" font-size="44" font-weight="${VIDEO_BRAND.font.titleWeight}" fill="${navy}" text-anchor="middle">-${pct}%</text>`,
      );
    }
  }

  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

/** Build the dry-run manifest. Pure — no Sharp, no network. */
export function buildCarouselManifest(config: CarouselConfig, timestamp: number): CarouselManifest {
  const items: CarouselManifestItem[] = config.items.map((item) => ({
    image_url: item.image_url,
    overlay_text: formatVideoTitle(item.overlay_text, 40, { uppercase: false, aggressive: false }),
    price: item.price,
    compare_at: item.compare_at,
    showsBadge: shouldShowBadge(item.price, item.compare_at),
    discountPct: discountPct(item.price, item.compare_at),
    sku: item.sku,
  }));

  return {
    items,
    format: config.format,
    brand: config.brand,
    language: config.language,
    count: items.length,
    wouldUploadTo: `slideshows/${config.brand}/carousel/${config.format}/${timestamp}/`,
    dryRun: true,
  };
}

/** Resolve and validate a brand logo path under public/, or null if absent. */
function resolveLogoPath(brand: SlideshowBrand): string | null {
  const rel = VIDEO_BRAND.logos[brandLogoLocale(brand)];
  const publicDir = path.resolve(process.cwd(), "public");
  const resolved = path.resolve(publicDir, rel);
  if (!resolved.startsWith(publicDir)) return null; // path-traversal guard
  return fs.existsSync(resolved) ? resolved : null;
}

/** Render one branded card PNG and return its bytes. */
async function renderCardPng(
  item: SlideshowItem,
  dims: { width: number; height: number },
  locale: VideoLocale,
  logoPath: string | null,
): Promise<Buffer> {
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;
  const navy = hexToRgb(VIDEO_BRAND.colors.navy);

  let base: import("sharp").Sharp;
  try {
    const buf = await downloadImage(item.image_url);
    base = sharpFn(buf).resize(dims.width, dims.height, { fit: "contain", background: navy }).flatten({ background: navy });
  } catch {
    base = sharpFn({ create: { width: dims.width, height: dims.height, channels: 3, background: navy } });
  }

  const composites: import("sharp").OverlayOptions[] = [
    { input: Buffer.from(buildCarouselOverlaySvg(item, dims, locale)), top: 0, left: 0 },
  ];

  if (logoPath) {
    try {
      const logoH = 90;
      const logo = await sharpFn(logoPath).resize({ height: logoH, fit: "inside" }).png().toBuffer();
      const meta = await sharpFn(logo).metadata();
      const logoW = meta.width ?? 200;
      composites.push({ input: logo, top: dims.height - logoH - 40, left: dims.width - logoW - 40 });
    } catch {
      // Logo unreadable → card keeps just its text overlay.
    }
  }

  return base.composite(composites).png().toBuffer();
}

/**
 * Render a carousel.
 *
 * dryRun → { manifest }. Otherwise → renders one PNG per item, uploads each to
 * the PUBLIC Vercel Blob store, and returns { blobUrls } in slide order. Throws
 * on an empty/invalid item list, a non-Shopify image, or a missing Blob token.
 */
export async function renderCarousel(config: CarouselConfig): Promise<CarouselResult> {
  if (!Array.isArray(config.items) || config.items.length < 1) {
    throw new Error("renderCarousel: at least one item is required");
  }
  config.items.forEach((item, i) => {
    if (!isShopifyCdnUrl(item.image_url)) {
      throw new Error(
        `renderCarousel: items[${i}].image_url must start with https://cdn.shopify.com/ (got "${item.image_url}")`,
      );
    }
  });

  const timestamp = Date.now();

  if (config.dryRun) {
    return { manifest: buildCarouselManifest(config, timestamp) };
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("renderCarousel: BLOB_READ_WRITE_TOKEN is required for a real render (public store)");
  }

  const dims = carouselDimensions(config.format);
  const locale = localeOf(config);
  const logoPath = resolveLogoPath(config.brand);
  const { put } = await import("@vercel/blob");

  const blobUrls: string[] = [];
  for (let i = 0; i < config.items.length; i++) {
    const png = await renderCardPng(config.items[i], dims, locale, logoPath);
    const blob = await put(carouselBlobPath(config.brand, config.format, timestamp, i), png, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    blobUrls.push(blob.url);
  }

  return { blobUrls };
}
