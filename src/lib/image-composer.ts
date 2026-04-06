import sharp from "sharp";
import path from "path";
import fs from "fs";
import { SOCIAL } from "./config";

const OUTPUT_DIR = path.join(process.cwd(), "public", "social-images");
const WIDTH = SOCIAL.IMAGE_WIDTH;
const HEIGHT = SOCIAL.IMAGE_HEIGHT;

export type TemplateType = "new_product" | "price_drop" | "stock_highlight";

export interface ComposeOptions {
  sku: string;
  templateType: TemplateType;
  productName: string;
  imageUrl: string;
  price: number;
  oldPrice?: number;
  qty?: number;
  language: "FR" | "EN";
  accentColor?: string;
  textColor?: string;
  storeName?: string;
  bannerOpacity?: number;
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sanitizeColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : fallback;
}

function createSvgOverlay(opts: ComposeOptions): string {
  const accent = sanitizeColor(opts.accentColor, SOCIAL.DEFAULT_ACCENT_COLOR);
  const textColor = sanitizeColor(opts.textColor, SOCIAL.DEFAULT_TEXT_COLOR);
  const store = opts.storeName || "Aosom Sync";
  const opacity = (opts.bannerOpacity ?? 75) / 100;

  if (opts.templateType === "price_drop") {
    const savings = opts.oldPrice && opts.oldPrice > opts.price
      ? Math.round(((opts.oldPrice - opts.price) / opts.oldPrice) * 100)
      : 0;
    const badgeText = opts.language === "FR" ? "PRIX RÉDUIT" : "PRICE DROP";
    return `
      <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="280" height="52" rx="0" fill="#dc2626" opacity="0.95"/>
        <text x="20" y="35" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#fff">${badgeText}</text>
        <rect x="0" y="${HEIGHT - 160}" width="${WIDTH}" height="160" fill="#000" opacity="${opacity}"/>
        <text x="40" y="${HEIGHT - 115}" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${textColor}">${escapeXml(opts.productName.slice(0, 60))}</text>
        <text x="40" y="${HEIGHT - 75}" font-family="Arial,sans-serif" font-size="22" fill="#ef4444" text-decoration="line-through">${opts.oldPrice?.toFixed(2)}$</text>
        <text x="${40 + (opts.oldPrice?.toFixed(2).length || 4) * 14 + 20}" y="${HEIGHT - 75}" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="#22c55e">${opts.price.toFixed(2)}$</text>
        ${savings > 0 ? `<text x="${40 + (opts.oldPrice?.toFixed(2).length || 4) * 14 + 20 + opts.price.toFixed(2).length * 20 + 20}" y="${HEIGHT - 75}" font-family="Arial,sans-serif" font-size="22" fill="#22c55e">-${savings}%</text>` : ""}
        <text x="${WIDTH - 200}" y="${HEIGHT - 20}" font-family="Arial,sans-serif" font-size="16" fill="${accent}" text-anchor="end">${escapeXml(store)}</text>
      </svg>`;
  }

  if (opts.templateType === "stock_highlight") {
    const bannerText = opts.language === "FR" ? "Disponible maintenant" : "Available now";
    return `
      <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${WIDTH}" height="52" fill="${accent}" opacity="0.9"/>
        <text x="${WIDTH / 2}" y="36" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#fff" text-anchor="middle">${bannerText}</text>
        <rect x="0" y="${HEIGHT - 130}" width="${WIDTH}" height="130" fill="#000" opacity="${opacity}"/>
        <text x="40" y="${HEIGHT - 80}" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${textColor}">${escapeXml(opts.productName.slice(0, 60))}</text>
        <text x="40" y="${HEIGHT - 40}" font-family="Arial,sans-serif" font-size="24" fill="${accent}">${opts.price.toFixed(2)}$${opts.qty ? ` | ${opts.qty} ${opts.language === "FR" ? "en stock" : "in stock"}` : ""}</text>
        <text x="${WIDTH - 200}" y="${HEIGHT - 20}" font-family="Arial,sans-serif" font-size="16" fill="${accent}" text-anchor="end">${escapeXml(store)}</text>
      </svg>`;
  }

  // new_product (default)
  return `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${HEIGHT - 140}" width="${WIDTH}" height="140" fill="#000" opacity="${opacity}"/>
      <text x="40" y="${HEIGHT - 90}" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${textColor}">${escapeXml(opts.productName.slice(0, 60))}</text>
      <text x="40" y="${HEIGHT - 45}" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${accent}">${opts.price.toFixed(2)}$</text>
      <text x="${WIDTH - 200}" y="${HEIGHT - 20}" font-family="Arial,sans-serif" font-size="16" fill="${accent}" text-anchor="end">${escapeXml(store)}</text>
    </svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Compose a social media image: product photo + overlay template.
 * Returns the relative path under /public/.
 */
export async function composeImage(opts: ComposeOptions): Promise<string> {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = Date.now();
  const filename = `${opts.sku}-${opts.templateType}-${timestamp}.jpg`;
  const outPath = path.join(OUTPUT_DIR, filename);

  // Download and resize product image to fill canvas
  let background: sharp.Sharp;
  try {
    const imgBuffer = await downloadImage(opts.imageUrl);
    background = sharp(imgBuffer).resize(WIDTH, HEIGHT, { fit: "cover" });
  } catch {
    // Fallback: solid dark background
    background = sharp({
      create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 30, g: 30, b: 40 } },
    });
  }

  const svgOverlay = Buffer.from(createSvgOverlay(opts));

  await background
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .jpeg({ quality: SOCIAL.IMAGE_QUALITY })
    .toFile(outPath);

  return `/social-images/${filename}`;
}
