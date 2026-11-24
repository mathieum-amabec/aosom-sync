/**
 * The "carte" image of a hot-topic post: a flat brand-red square with white bold text in two blocks —
 * a smaller FACT line that names the subject ("Le Canadien a perdu 3-4 contre les Flyers…") and the
 * big QUESTION under it. Someone scrolling must understand the subject without reading anything else.
 * Rendered as SVG → PNG by sharp with the bundled DM Sans Bold: no AI image call, no per-post cost,
 * identical look every time.
 *
 * Text layout is computed here (greedy word-wrap + a font-size search) instead of left to librsvg,
 * which has no text wrapping — every line is its own <text> element, centred.
 */
import { registerBrandFonts } from "@/lib/register-brand-fonts";

registerBrandFonts();

export const CARD_SIZE = 1080;
export const CARD_BG = "#CF2C42";

const MAX_TEXT_WIDTH = 900;
const MAX_TEXT_HEIGHT = 780;
/** Average glyph width of DM Sans Bold as a fraction of the font size (conservative: wider than real). */
const CHAR_W = 0.6;
const LINE_H = 1.18;
/** The fact line is set at this fraction of the question's size. */
const FACT_RATIO = 0.6;
const MIN_FACT_SIZE = 36;
const MIN_QUESTION_SIZE = 52;

export interface CardLayout {
  /** Question font size. */
  fontSize: number;
  factFontSize: number;
  factLines: string[];
  /** Question lines. */
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

function layoutAt(fact: string, question: string, size: number): CardLayout & { fits: boolean } {
  const factSize = Math.max(MIN_FACT_SIZE, Math.round(size * FACT_RATIO));
  const factLines = fact.trim() ? wrapText(fact, Math.floor(MAX_TEXT_WIDTH / (factSize * CHAR_W))) : [];
  const lines = wrapText(question, Math.floor(MAX_TEXT_WIDTH / (size * CHAR_W)));
  const tooWide =
    factLines.some((l) => l.length * factSize * CHAR_W > MAX_TEXT_WIDTH + 1) ||
    lines.some((l) => l.length * size * CHAR_W > MAX_TEXT_WIDTH + 1);
  const gap = factLines.length ? size * 0.9 : 0;
  const height = factLines.length * factSize * LINE_H + gap + lines.length * size * LINE_H;
  return { fontSize: size, factFontSize: factSize, factLines, lines, fits: !tooWide && height <= MAX_TEXT_HEIGHT };
}

/** Largest question size at which both blocks fit the card; never below 52 px. */
export function layoutCard(fact: string, question: string): CardLayout {
  for (let size = 88; size >= MIN_QUESTION_SIZE; size -= 4) {
    const l = layoutAt(fact, question, size);
    if (l.fits) return { fontSize: l.fontSize, factFontSize: l.factFontSize, factLines: l.factLines, lines: l.lines };
  }
  const l = layoutAt(fact, question, MIN_QUESTION_SIZE);
  return { fontSize: l.fontSize, factFontSize: l.factFontSize, factLines: l.factLines, lines: l.lines };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the card SVG. Pure — unit-testable without sharp. */
export function buildCardSvg(fact: string, question: string): { svg: string; layout: CardLayout } {
  const layout = layoutCard(fact, question);
  const { fontSize, factFontSize, factLines, lines } = layout;
  const factLineH = factFontSize * LINE_H;
  const qLineH = fontSize * LINE_H;
  const gap = factLines.length ? fontSize * 0.9 : 0;
  const blockH = factLines.length * factLineH + gap + lines.length * qLineH;
  // First baseline: block centred vertically, nudged up a little to leave room for the footer.
  const top = (CARD_SIZE - blockH) / 2 - 20;
  const cx = CARD_SIZE / 2;

  const factTexts = factLines
    .map((l, i) => `<text x="${cx}" y="${(top + factLineH * i + factFontSize * 0.85).toFixed(1)}" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  const qTop = top + factLines.length * factLineH + gap;
  const qTexts = lines
    .map((l, i) => `<text x="${cx}" y="${(qTop + qLineH * i + fontSize * 0.85).toFixed(1)}" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  // A short rule between the two blocks.
  const ruleY = top + factLines.length * factLineH + gap / 2 - 2;
  const rule = factLines.length
    ? `<rect x="${cx - 60}" y="${ruleY.toFixed(1)}" width="120" height="4" rx="2" fill="#FFFFFF" fill-opacity="0.6"/>`
    : "";

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">` +
    `<rect width="100%" height="100%" fill="${CARD_BG}"/>` +
    (factTexts ? `<g font-family="DM Sans, sans-serif" font-weight="700" font-size="${factFontSize}" fill="#FFFFFF" fill-opacity="0.92">${factTexts}</g>` : "") +
    rule +
    `<g font-family="DM Sans, sans-serif" font-weight="700" font-size="${fontSize}" fill="#FFFFFF">${qTexts}</g>` +
    `<text x="${cx}" y="${CARD_SIZE - 52}" text-anchor="middle" font-family="DM Sans, sans-serif" font-weight="700" font-size="30" fill="#FFFFFF" fill-opacity="0.78">Ameublo Direct</text>` +
    `</svg>`;
  return { svg, layout };
}

/** Rasterise the card to a PNG buffer. */
export async function renderCardPng(fact: string, question: string): Promise<{ png: Buffer; layout: CardLayout }> {
  const sharp = (await import("sharp")).default;
  const { svg, layout } = buildCardSvg(fact, question);
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
