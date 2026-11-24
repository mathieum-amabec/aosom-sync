/**
 * The "carte" image of a hot-topic post: a flat brand-red square with big white bold text — a lead
 * line ("Tu en penses quoi?") then the question. Rendered as SVG → PNG by sharp with the bundled
 * DM Sans Bold: no AI image call, no per-post cost, identical look every time.
 *
 * Text layout is computed here (greedy word-wrap + a font-size search) instead of left to librsvg,
 * which has no text wrapping — every line is its own <text> element, centred.
 */
import { registerBrandFonts } from "@/lib/register-brand-fonts";

registerBrandFonts();

export const CARD_SIZE = 1080;
export const CARD_BG = "#CF2C42";

const MAX_TEXT_WIDTH = 900;
const MAX_TEXT_HEIGHT = 760;
/** Average glyph width of DM Sans Bold as a fraction of the font size (conservative: wider than real). */
const CHAR_W = 0.6;
const LINE_H = 1.18;
const BLOCK_GAP_LINES = 1;

export interface CardLayout {
  fontSize: number;
  /** Lines in order; an empty string is the gap between the lead and the question. */
  lines: string[];
}

/** Greedy word-wrap on a character budget; a single over-long word gets its own line. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Largest font size at which lead + question fit the card; never below 52 px. */
export function layoutCard(lead: string, question: string): CardLayout {
  for (let size = 96; size >= 52; size -= 4) {
    const maxChars = Math.floor(MAX_TEXT_WIDTH / (size * CHAR_W));
    const leadLines = lead.trim() ? wrapText(lead, maxChars) : [];
    const qLines = wrapText(question, maxChars);
    const lines = [...leadLines, ...(leadLines.length ? Array(BLOCK_GAP_LINES).fill("") : []), ...qLines];
    const tooWide = lines.some((l) => l.length * size * CHAR_W > MAX_TEXT_WIDTH + 1);
    if (!tooWide && lines.length * size * LINE_H <= MAX_TEXT_HEIGHT) return { fontSize: size, lines };
  }
  const size = 52;
  const maxChars = Math.floor(MAX_TEXT_WIDTH / (size * CHAR_W));
  const leadLines = lead.trim() ? wrapText(lead, maxChars) : [];
  const lines = [...leadLines, ...(leadLines.length ? [""] : []), ...wrapText(question, maxChars)];
  return { fontSize: size, lines };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the card SVG. Pure — unit-testable without sharp. */
export function buildCardSvg(lead: string, question: string): { svg: string; layout: CardLayout } {
  const layout = layoutCard(lead, question);
  const { fontSize, lines } = layout;
  const lineH = fontSize * LINE_H;
  const blockH = lines.length * lineH;
  // First baseline: block centred vertically, nudged up a little to leave room for the footer.
  const top = (CARD_SIZE - blockH) / 2 - 20;
  const texts = lines
    .map((l, i) => (l ? `<text x="${CARD_SIZE / 2}" y="${(top + lineH * i + fontSize * 0.85).toFixed(1)}" text-anchor="middle">${esc(l)}</text>` : ""))
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">` +
    `<rect width="100%" height="100%" fill="${CARD_BG}"/>` +
    `<g font-family="DM Sans, sans-serif" font-weight="700" font-size="${fontSize}" fill="#FFFFFF">${texts}</g>` +
    `<text x="${CARD_SIZE / 2}" y="${CARD_SIZE - 52}" text-anchor="middle" font-family="DM Sans, sans-serif" font-weight="700" font-size="30" fill="#FFFFFF" fill-opacity="0.78">Ameublo Direct</text>` +
    `</svg>`;
  return { svg, layout };
}

/** Rasterise the card to a PNG buffer. */
export async function renderCardPng(lead: string, question: string): Promise<{ png: Buffer; layout: CardLayout }> {
  const sharp = (await import("sharp")).default;
  const { svg, layout } = buildCardSvg(lead, question);
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  return { png, layout };
}

/**
 * Upload the PNG to the PUBLIC Blob store (Meta fetches the URL server-side, so a private store
 * would make every publish fail). Returns the public URL.
 */
export async function uploadCardPng(png: Buffer, slug: string): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN not configured — cannot store the card image");
  const { put } = await import("@vercel/blob");
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "carte";
  const blob = await put(`hot-topics/${safe}.png`, png, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: true,
  });
  return blob.url;
}
