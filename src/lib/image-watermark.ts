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
