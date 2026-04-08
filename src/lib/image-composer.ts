import path from "path";
import fs from "fs";
import { SOCIAL } from "./config";

const WIDTH = SOCIAL.IMAGE_WIDTH;
const HEIGHT = SOCIAL.IMAGE_HEIGHT;

function getOutputDir(): string {
  // Vercel: /tmp is writable. Local dev: public/social-images
  const dir = process.env.VERCEL
    ? path.join("/tmp", "social-images")
    : path.join(process.cwd(), "public", "social-images");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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
  // SSRF protection: only allow HTTPS URLs to public hosts
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS image URLs allowed");
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]" ||
      host.startsWith("127.") || host.startsWith("10.") || host.startsWith("0.") ||
      host.startsWith("172.") || host.startsWith("192.168.") ||
      host === "169.254.169.254" || host.startsWith("[") ||
      /^fe[89ab]/i.test(host) || /^fd/i.test(host) || /^fc/i.test(host) ||
      host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Image URL points to internal network");
  }
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
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Compose a social media image: product photo + overlay template.
 * Returns the relative path. On Vercel, writes to /tmp/. On local dev, writes to public/.
 */
export async function composeImage(opts: ComposeOptions): Promise<string> {
  // Dynamic import — avoids loading sharp for routes that don't need it
  const sharpModule = await import("sharp");
  const sharpFn = sharpModule.default;

  const outputDir = getOutputDir();
  const timestamp = Date.now();
  const filename = `${opts.sku}-${opts.templateType}-${timestamp}.jpg`;
  const outPath = path.join(outputDir, filename);

  let background: import("sharp").Sharp;
  try {
    const imgBuffer = await downloadImage(opts.imageUrl);
    background = sharpFn(imgBuffer).resize(WIDTH, HEIGHT, { fit: "cover" });
  } catch {
    background = sharpFn({
      create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 30, g: 30, b: 40 } },
    });
  }

  const svgOverlay = Buffer.from(createSvgOverlay(opts));

  await background
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .jpeg({ quality: SOCIAL.IMAGE_QUALITY })
    .toFile(outPath);

  // On Vercel, return the /tmp path. On local, return the public-relative path.
  return process.env.VERCEL ? outPath : `/social-images/${filename}`;
}

/**
 * Resolve an image path for reading (handles both /tmp and public/ paths).
 */
export function resolveImagePath(imagePath: string): string {
  if (imagePath.startsWith("/tmp/")) {
    // Prevent path traversal from /tmp/
    const resolved = path.resolve(imagePath);
    if (!resolved.startsWith("/tmp/")) throw new Error("Invalid image path");
    return resolved;
  }
  const resolved = path.resolve(process.cwd(), "public", imagePath);
  const publicDir = path.resolve(process.cwd(), "public");
  if (!resolved.startsWith(publicDir)) throw new Error("Invalid image path");
  return resolved;
}
