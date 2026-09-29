/**
 * Studio text overlays drawn as SVG → transparent PNG layers, then composited by ffmpeg's
 * `overlay` filter.
 *
 * Why not ffmpeg drawtext: the ffmpeg-static Linux binary that runs on Vercel is built WITHOUT
 * the drawtext filter (no libfreetype) — every render died with "No such filter: 'drawtext'".
 * SVG text rendered by sharp (librsvg + fontconfig, DM Sans registered by registerBrandFonts)
 * is the path the slideshow engine already uses in production.
 *
 * Pure SVG builders (unit-tested) + one writer.
 */
import type { StudioLocale } from "./options";

const NAVY = "#1A2340";
const GOLD = "#D4A853";
const FONT = `'DM Sans', Arial, sans-serif`;

export const STUDIO_LABELS = { fr: ["AVANT", "APRÈS"], en: ["BEFORE", "AFTER"] } as const;
export const STUDIO_DOMAIN = { fr: "ameublodirect.ca", en: "furnishdirect.ca" } as const;

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Greedy word wrap on an average-glyph-width estimate (SVG can't measure text before render). */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines = 2): string[] {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.56)));
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].replace(/[\s,;:—-]+$/, "");
  return kept;
}

/** Approximate rendered width of a bold DM Sans string, for sizing the CTA pill. */
const approxWidth = (text: string, fontSize: number) => Math.round(text.length * fontSize * 0.58);

export interface LayerGeometry {
  w: number;
  h: number;
  /** Top of the navy brand bar (ffmpeg draws the bar + logo plate itself). */
  barY: number;
  barH: number;
}

export interface StudioTexts {
  locale: StudioLocale;
  labels: boolean;
  title: string;
  price: string;
  cta: string;
}

const svg = (g: LayerGeometry, body: string) =>
  `<svg width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

/** Always-on layer: title band at the top, gold CTA pill, domain in the brand bar. */
export function baseLayerSvg(g: LayerGeometry, t: StudioTexts): string {
  const parts: string[] = [];
  if (t.title) {
    const fs = Math.round(g.w * 0.052);
    const lines = wrapText(t.title, fs, g.w - 120);
    const lineH = Math.round(fs * 1.22);
    const top = Math.round(g.h * 0.055);
    const bandH = lines.length * lineH + Math.round(fs * 0.9);
    parts.push(`<rect x="0" y="${top}" width="${g.w}" height="${bandH}" fill="${NAVY}" fill-opacity="0.72"/>`);
    lines.forEach((ln, i) => {
      const y = top + Math.round(fs * 0.45) + fs + i * lineH;
      parts.push(`<text x="${g.w / 2}" y="${y}" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="#FFFFFF" text-anchor="middle">${escapeXml(ln)}</text>`);
    });
  }
  if (t.cta) {
    const fs = Math.round(g.w * 0.036);
    const pillW = Math.min(g.w - 80, approxWidth(t.cta, fs) + 64);
    const pillH = Math.round(fs * 1.9);
    const y = g.barY - Math.round(g.h * 0.03) - pillH;
    parts.push(`<rect x="${Math.round((g.w - pillW) / 2)}" y="${y}" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 2)}" fill="${GOLD}"/>`);
    parts.push(`<text x="${g.w / 2}" y="${y + Math.round(pillH / 2 + fs * 0.35)}" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="${NAVY}" text-anchor="middle">${escapeXml(t.cta)}</text>`);
  }
  const dfs = Math.round(g.barH * 0.27);
  parts.push(
    `<text x="${g.w - 52}" y="${g.barY + Math.round(g.barH / 2 + dfs * 0.35)}" font-family="${FONT}" font-size="${dfs}" font-weight="700" fill="${GOLD}" text-anchor="end">${escapeXml(STUDIO_DOMAIN[t.locale])}</text>`,
  );
  return svg(g, parts.join(""));
}

/** AVANT (index 0) or APRÈS (index 1) label with its gold underline; the APRÈS layer also carries the price. */
export function labelLayerSvg(g: LayerGeometry, t: StudioTexts, which: 0 | 1): string {
  const parts: string[] = [];
  if (t.labels) {
    const fs = Math.round(g.w * 0.092);
    const y = Math.round(g.h * 0.6) + fs;
    parts.push(
      `<text x="${g.w / 2}" y="${y}" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="#FFFFFF" text-anchor="middle" stroke="#000000" stroke-opacity="0.45" stroke-width="3" paint-order="stroke">${escapeXml(STUDIO_LABELS[t.locale][which])}</text>`,
    );
    parts.push(`<rect x="${Math.round((g.w - 380) / 2)}" y="${y + Math.round(fs * 0.3)}" width="380" height="6" fill="${GOLD}"/>`);
  }
  if (which === 1 && t.price) {
    const fs = Math.round(g.w * 0.068);
    const y = g.barY - Math.round(g.h * 0.03) - Math.round(g.w * 0.036 * 1.9) - Math.round(fs * 0.6);
    parts.push(
      `<text x="${g.w / 2}" y="${y}" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="#FFFFFF" text-anchor="middle" stroke="#000000" stroke-opacity="0.55" stroke-width="3" paint-order="stroke">${escapeXml(t.price)}</text>`,
    );
  }
  return svg(g, parts.join(""));
}

/** Rasterise an SVG layer to a transparent PNG file. */
export async function writeLayerPng(svgText: string, out: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  await sharp(Buffer.from(svgText)).png().toFile(out);
}
