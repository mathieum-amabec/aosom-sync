/**
 * Branded image compositor for social posts.
 *
 * Composes a square 1080×1080 post image from a raw Aosom product photo:
 * off-white canvas → product photo (contain, ~80% of the upper area) → a navy
 * footer band carrying the locale-specific logo (Ameublo Direct FR / Furnish
 * Direct EN) and the price → an optional copper "NEW"/"SALE" badge top-right.
 *
 * Output is a PNG Buffer so callers can stream it (the /api/image-preview route)
 * or upload it. Unlike the legacy `image-composer.ts` (full-bleed photo + dark
 * gradient overlay, JPG written to disk), this produces a clean branded frame
 * with the real store logo.
 *
 * sharp-only: product/logo resizing + compositing via sharp, all text drawn via
 * an inline SVG layer (no node-canvas).
 */
import path from "path";
import fs from "fs";
import { downloadImage } from "./image-composer";

// ─── Layout constants (1080×1080 Instagram/Facebook square) ──────────────
export const CANVAS = 1080;
export const BAND_HEIGHT = 200;
/** Area above the footer band that holds the product photo. */
export const PRODUCT_AREA_HEIGHT = CANVAS - BAND_HEIGHT; // 880
/** Product photo fits inside 80% of the available product area. */
export const PRODUCT_FIT_RATIO = 0.8;
export const PRODUCT_MAX_WIDTH = Math.round(CANVAS * PRODUCT_FIT_RATIO); // 864
export const PRODUCT_MAX_HEIGHT = Math.round(PRODUCT_AREA_HEIGHT * PRODUCT_FIT_RATIO); // 704
export const LOGO_MAX_WIDTH = 200;
export const LOGO_MARGIN_X = 48;
/** Cap on decoded product-image pixels — guards sharp against decompression bombs. */
export const MAX_INPUT_PIXELS = 100_000_000; // 100 MP

export const COLORS = {
  background: "#FAFAF8", // off-white
  band: "#1A2340", // navy
  accent: "#C17F3E", // copper
  text: "#FFFFFF",
} as const;

export type Locale = "fr" | "en";
export type Badge = "sale" | "new";

export interface ComposeProductImageOptions {
  /** Public HTTPS URL of the raw Aosom product photo. */
  productImageUrl: string;
  /** Display price, already formatted (e.g. "249.99 CAD"). */
  price: string;
  /** fr → Ameublo Direct logo, en → Furnish Direct logo. */
  locale: Locale;
  /** Optional promo badge shown top-right. */
  badge?: Badge;
}

const BADGE_LABELS: Record<Badge, Record<Locale, string>> = {
  new: { fr: "NOUVEAU", en: "NEW" },
  sale: { fr: "SOLDE", en: "SALE" },
};

/** Localized badge text, or null when no badge requested. */
export function badgeLabel(locale: Locale, badge?: Badge): string | null {
  if (!badge) return null;
  return BADGE_LABELS[badge][locale];
}

/** Absolute path to the logo PNG for a locale. Bundled via outputFileTracingIncludes. */
export function logoPath(locale: Locale): string {
  return path.join(process.cwd(), "Logo", locale === "fr" ? "logo-fr.png" : "logo-en.png");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the SVG text/shape layer composited over the full canvas: the navy
 * footer band, the right-aligned price, and the optional copper badge.
 * The logo is composited separately (it's a raster PNG, not SVG).
 *
 * Pure + deterministic so it can be unit-tested without sharp.
 */
export function buildBrandedSvg(opts: ComposeProductImageOptions): string {
  const price = escapeXml(opts.price);
  const label = badgeLabel(opts.locale, opts.badge);

  // Badge box sized to its text: ~10px/char at 16px bold + horizontal padding.
  let badgeSvg = "";
  if (label) {
    const badgeText = escapeXml(label);
    const badgeW = badgeText.length * 10 + 28;
    const badgeH = 38;
    const badgeX = CANVAS - 40 - badgeW;
    const badgeY = 40;
    badgeSvg = `
    <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="6" fill="${COLORS.accent}"/>
    <text x="${badgeX + badgeW / 2}" y="${badgeY + 25}" font-family="'DM Sans',Arial,Helvetica,sans-serif" font-size="16" font-weight="700" letter-spacing="1" fill="${COLORS.text}" text-anchor="middle">${badgeText}</text>`;
  }

  // Price baseline sits roughly at the vertical centre of the band.
  const bandTop = PRODUCT_AREA_HEIGHT;
  const priceBaseline = bandTop + BAND_HEIGHT / 2 + 13;

  return `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${bandTop}" width="${CANVAS}" height="${BAND_HEIGHT}" fill="${COLORS.band}"/>
    <text x="${CANVAS - LOGO_MARGIN_X}" y="${priceBaseline}" font-family="'DM Sans',Arial,Helvetica,sans-serif" font-size="36" font-weight="700" fill="${COLORS.text}" text-anchor="end">${price}</text>${badgeSvg}
  </svg>`;
}

/**
 * Compose the branded product image. Returns a PNG Buffer.
 *
 * On any failure downloading/decoding the product photo, falls back to a plain
 * off-white product area (band + logo + price still render) rather than throwing
 * — a degraded branded image still beats no image for the caller.
 */
export async function composeProductImage(opts: ComposeProductImageOptions): Promise<Buffer> {
  // Dynamic import keeps sharp out of bundles/routes that never compose images.
  const sharp = (await import("sharp")).default;

  // 1. Off-white canvas.
  const base = sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: COLORS.background,
    },
  });

  const composites: import("sharp").OverlayOptions[] = [];

  // 2. Product photo: contain within 80% of the product area, centred.
  try {
    const raw = await downloadImage(opts.productImageUrl);
    const resized = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(PRODUCT_MAX_WIDTH, PRODUCT_MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = Math.max(0, Math.round((CANVAS - resized.info.width) / 2));
    const top = Math.max(0, Math.round((PRODUCT_AREA_HEIGHT - resized.info.height) / 2));
    composites.push({ input: resized.data, top, left });
  } catch (err) {
    // Leave the product area off-white; band/logo/price still compose below.
    console.warn(`[image-compositor] product image failed (${opts.productImageUrl}): ${err}`);
  }

  // 3. Footer band + price + badge (SVG layer over the whole canvas).
  composites.push({ input: Buffer.from(buildBrandedSvg(opts)), top: 0, left: 0 });

  // 4. Logo in the band, bottom-left, vertically centred.
  try {
    const logoRaw = fs.readFileSync(logoPath(opts.locale));
    const logo = await sharp(logoRaw)
      .resize(LOGO_MAX_WIDTH, null, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const logoTop = PRODUCT_AREA_HEIGHT + Math.round((BAND_HEIGHT - logo.info.height) / 2);
    composites.push({ input: logo.data, top: logoTop, left: LOGO_MARGIN_X });
  } catch (err) {
    // Logo missing/unreadable — skip it rather than fail the whole image. Warn
    // loudly: a logo-less "branded" image defeats the feature, and the usual
    // cause is the logo PNG not being bundled (see outputFileTracingIncludes).
    console.warn(`[image-compositor] logo failed for locale=${opts.locale}: ${err}`);
  }

  return base.composite(composites).png().toBuffer();
}
