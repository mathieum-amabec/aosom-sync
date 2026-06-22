import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { put, del } from "@vercel/blob";
import sharp from "sharp";
import type { FacebookBrand } from "./facebook-client";

/**
 * Brand footer watermarking for social images.
 *
 * Facebook posts publish the raw Shopify CDN image with no branding. This module
 * downloads a copy of that image (we NEVER touch the Shopify asset) and stamps a
 * navy footer bar across the bottom carrying the brand name + free-shipping slogan,
 * returning a PNG buffer ready for binary upload to the Meta Graph API.
 *
 * Output dimensions: same width as the input, height = input height + FOOTER_HEIGHT.
 */

export const FOOTER_HEIGHT = 60;
const FOOTER_NAVY = "#1B2A4A";
const SLOGAN = "Livraison gratuite au Canada";
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** Directory where the bundled DM Sans TTFs live (traced into the function bundle). */
export function bundledFontsDir(): string {
  return path.join(process.cwd(), "src", "fonts");
}

/**
 * Build the fontconfig document that adds our bundled fonts dir to the search path.
 * Keeps the system fonts via an ignore-missing include (so the SVG's Arial/sans-serif
 * fallback still resolves where a system config exists).
 */
export function buildFontconfigXml(fontsDir: string, cacheDir: string): string {
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>`;
}

/**
 * Register the bundled DM Sans TTFs with the SVG text renderer.
 *
 * The footer is drawn as SVG text rendered by librsvg/Pango, which resolve fonts via
 * **fontconfig** — NOT Sharp's `fontfile` option (that only applies to `sharp({text})`).
 * So to make `font-family: "DM Sans"` actually render DM Sans (instead of falling back
 * to a system sans-serif), we write a fontconfig file pointing at src/fonts and set
 * FONTCONFIG_FILE before the first render.
 *
 * Scoped to Linux (the Vercel runtime that renders these posts): on dev machines we
 * leave the platform font resolution untouched to avoid perturbing the local Sharp
 * build. Best-effort — any failure falls back to the previous behaviour (the footer
 * still renders, just in the fallback face), so font setup can never break publishing.
 */
function configureBundledFonts(): void {
  if (process.platform !== "linux") return;
  if (process.env.FONTCONFIG_FILE) return; // already configured by us or the platform
  try {
    const fontsDir = bundledFontsDir();
    if (!fs.existsSync(path.join(fontsDir, "DMSans-Bold.ttf"))) return; // not bundled in this function
    const cacheDir = path.join(os.tmpdir(), "fontconfig-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const confPath = path.join(os.tmpdir(), "aosom-fonts.conf");
    fs.writeFileSync(confPath, buildFontconfigXml(fontsDir, cacheDir));
    process.env.FONTCONFIG_FILE = confPath;
  } catch {
    // non-fatal — fall back to system font resolution
  }
}

// Runs once at module load, before any Sharp/libvips render in this function.
configureBundledFonts();

const BRAND_LABEL: Record<FacebookBrand, string> = {
  ameublo: "Ameublo Direct",
  furnish: "Furnish Direct",
};

/** Escape the small set of chars that would break the SVG we build by hand. */
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );
}

/**
 * Footer overlay as an SVG buffer: a 90%-opacity navy bar with the brand name on
 * the left (DM Sans, bold, white) and the slogan on the right (13px, white). Baselines
 * are set explicitly (not via dominant-baseline) so vertical centering is consistent
 * across the SVG renderers libvips may be built against.
 */
function footerSvg(width: number, brandLabel: string): Buffer {
  const padX = 20;
  const svg = `<svg width="${width}" height="${FOOTER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${FOOTER_HEIGHT}" fill="${FOOTER_NAVY}" fill-opacity="0.9"/>
  <text x="${padX}" y="38" font-family="DM Sans, Arial, sans-serif" font-size="22" font-weight="700" fill="#FFFFFF">${escapeXml(brandLabel)}</text>
  <text x="${width - padX}" y="37" font-family="DM Sans, Arial, sans-serif" font-size="13" fill="#FFFFFF" text-anchor="end">${escapeXml(SLOGAN)}</text>
</svg>`;
  return Buffer.from(svg);
}

/**
 * Download the image at `imageUrl` and return a PNG buffer with the brand footer
 * composited across the bottom. Throws on download failure, unreadable dimensions,
 * or an unknown brand — the caller (publish path) treats that like any publish error.
 */
export async function addWatermarkToImage(imageUrl: string, brand: FacebookBrand): Promise<Buffer> {
  const label = BRAND_LABEL[brand];
  if (!label) throw new Error(`addWatermarkToImage: unknown brand "${brand}"`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let input: Buffer;
  try {
    const res = await fetch(imageUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`addWatermarkToImage: failed to download image (HTTP ${res.status}) ${imageUrl}`);
    input = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`addWatermarkToImage: image download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s ${imageUrl}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const { width, height } = await sharp(input).metadata();
  if (!width || !height) throw new Error("addWatermarkToImage: could not read source image dimensions");

  // Extend the canvas downward by FOOTER_HEIGHT (white fill behind the 90% bar), then
  // composite the footer over the new strip. Operates on the in-memory copy only.
  return sharp(input)
    .extend({ top: 0, bottom: FOOTER_HEIGHT, left: 0, right: 0, background: "#FFFFFF" })
    .composite([{ input: footerSvg(width, label), top: height, left: 0 }])
    .png()
    .toBuffer();
}

const WATERMARK_BLOB_PREFIX = "social-watermark";

export interface HostedWatermark {
  /** Public Vercel Blob URL of the watermarked PNG, suitable for Instagram's image_url. */
  url: string;
  /** Delete the temporary blob. Call after publishing (Meta has fetched it by then). */
  cleanup: () => Promise<void>;
}

/**
 * Watermark an image and host it at a public URL for Instagram.
 *
 * Unlike Facebook (which uploads the watermarked buffer as binary), the Instagram Graph
 * API only accepts a public `image_url` it can fetch server-side. So we stamp the footer
 * to a PNG buffer, upload it to Vercel Blob (public), and return that URL. The caller MUST
 * invoke `cleanup()` once publishing is done so the temporary blob doesn't accumulate.
 */
export async function uploadWatermarkedImage(imageUrl: string, brand: FacebookBrand): Promise<HostedWatermark> {
  const buffer = await addWatermarkToImage(imageUrl, brand);
  const blobPath = `${WATERMARK_BLOB_PREFIX}/${brand}/${crypto.randomUUID()}.png`;
  const blob = await put(blobPath, buffer, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
  });
  return {
    url: blob.url,
    cleanup: async () => {
      try {
        await del(blob.url);
      } catch (err) {
        // Non-fatal — never let cleanup break a successful publish. But log it: if del
        // starts failing (token/permission/rate-limit) these temp blobs accumulate, and a
        // silent catch would hide that until the storage bill does.
        console.warn(`[watermark] failed to delete temp blob ${blob.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
