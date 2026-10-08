/**
 * Automatic import — verification layers. A product reaches the storefront only after ALL of them pass.
 *
 *   Layer 1  deterministic rules on the generated copy (free, no LLM): required fields, template
 *            leftovers, English units/words, broken HTML, prices in the copy, supplier brands, and
 *            "every measurement in the copy must exist in the supplier data" (the guard against invented facts).
 *   Layer 2  an independent judge model re-reads the copy against the supplier data, and a vision model
 *            looks at the gallery (supplier logos, watermarks, non-product images).
 *   Layer 3  after the draft is created: what Shopify actually stores (variants, prices, inventory
 *            tracking, images) and, once activated, what the public product page serves.
 *
 * Layers 1 and 2 run BEFORE anything is created on Shopify. Every function returns reasons instead of
 * throwing, so a failure becomes a "needs_review" with a readable cause, never a half-published product.
 */
import { forbiddenBrandsIn, detectDescriptionLanguage } from "@/lib/catalog-guard";
import { budgetedCreate } from "@/lib/llm-budget";
import { llmModel } from "@/lib/llm-models";
import { getAnthropicClient, type GeneratedContent } from "@/lib/content-generator";
import type { AosomMergedProduct } from "@/types/aosom";

export interface Verdict {
  ok: boolean;
  reasons: string[];
}

const textOf = (html: string) =>
  (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// ── Layer 1 ────────────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE =
  /\[BRAND[ _]?NAME\]|\{\{|\}\}|lorem ipsum|\bundefined\b|\bNaN\b|\[object |\bTODO\b|as an ai\b|en tant qu['’]ia|je ne peux pas|i cannot|```/i;
const ENGLISH_UNIT_RE = /\b\d+(?:[.,]\d+)?\s?(?:inches|inch|lbs?|pounds|ounces|oz|feet|ft|gallons?|gal)\b/i;
const PRICE_IN_COPY_RE = /\b\d{1,5}(?:[.,]\d{2})\s?\$|\$\s?\d{1,5}(?:[.,]\d{2})?\b/;
const UNSAFE_HTML_RE = /<script|<iframe|<style|\bon\w+\s*=|javascript:/i;
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
};

/** Units whose number is a verifiable claim, normalised to a family so conversions can be applied. */
const CLAIM_UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s?(cm|mm|m|kg|g|l|litres?|w|watts?|v|volts?|po|pouces?|pi|pieds?|lb|lbs|pi²|m²|pièces?|places?|tiroirs?|niveaux|tablettes|étagères|portes?|roues|compartiments)\b/gi;

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)/g)) {
    const n = Number(m[1].replace(",", "."));
    if (Number.isFinite(n)) out.push(n);
  }
  for (const w of text.toLowerCase().match(/[a-zéè]+/g) ?? []) if (w in WORD_NUMBERS) out.push(WORD_NUMBERS[w]);
  return out;
}

/** Every number the supplier data supports, with the unit conversions the copy may legitimately apply. */
export function sourceNumberSet(product: AosomMergedProduct): number[] {
  const raw = [
    product.name,
    product.description,
    product.shortDescription,
    product.material,
    ...product.variants.flatMap((v) => [v.size, v.color, v.boxSize]),
  ]
    .filter(Boolean)
    .map((s) => textOf(String(s)))
    .join(" ");
  const base = numbersIn(raw);
  for (const v of product.variants) {
    base.push(v.weight, v.boxWeight ? Number(v.boxWeight) : 0, v.dimensions?.length ?? 0, v.dimensions?.width ?? 0, v.dimensions?.height ?? 0);
  }
  const set = new Set<number>();
  const factors = [1, 2.54, 1 / 2.54, 0.45359237, 1 / 0.45359237, 0.3048, 30.48, 1 / 30.48, 3.78541, 1 / 3.78541, 10, 0.1, 25.4, 1 / 25.4, 0.0929, 0.092903];
  for (const b of base) {
    if (!Number.isFinite(b) || b <= 0) continue;
    for (const f of factors) set.add(b * f);
  }
  return [...set];
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.04);

/** Measurements/counts in the copy that the supplier data cannot explain. Empty = all supported. */
export function unsupportedClaims(text: string, product: AosomMergedProduct): string[] {
  const source = sourceNumberSet(product);
  const bad: string[] = [];
  for (const m of text.matchAll(CLAIM_UNIT_RE)) {
    const n = Number(m[1].replace(",", "."));
    if (!Number.isFinite(n) || n === 0) continue;
    if (!source.some((s) => close(s, n))) bad.push(`${m[1]} ${m[2]}`);
  }
  return [...new Set(bad)];
}

function tagBalance(html: string, tag: string): number {
  const open = (html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi")) ?? []).length;
  const close_ = (html.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
  return open - close_;
}

export function checkContentStructure(product: AosomMergedProduct, c: GeneratedContent): Verdict {
  const reasons: string[] = [];
  const fr = textOf(c.descriptionFr);
  const en = textOf(c.descriptionEn);

  const need: Array<[string, string, number]> = [
    ["titleFr", c.titleFr, 15],
    ["titleEn", c.titleEn, 10],
    ["metaTitleFr", c.metaTitleFr, 10],
    ["metaDescriptionFr", c.metaDescriptionFr, 40],
    ["urlHandleFr", c.urlHandleFr, 5],
  ];
  for (const [name, v, min] of need) if (!v || v.trim().length < min) reasons.push(`missing_or_short:${name}`);
  if (fr.length < 250) reasons.push("description_fr_too_short");
  if (en.length < 150) reasons.push("description_en_too_short");
  if ((c.titleFr || "").length > 150) reasons.push("title_fr_too_long");
  if (!Array.isArray(c.tags) || c.tags.length === 0) reasons.push("no_tags");

  const all = [c.titleFr, c.titleEn, c.descriptionFr, c.descriptionEn, c.metaTitleFr, c.metaDescriptionFr].join("\n");
  if (PLACEHOLDER_RE.test(all)) reasons.push("template_leftover");
  if (ENGLISH_UNIT_RE.test(`${c.titleFr} ${c.descriptionFr}`)) reasons.push("english_units_in_french_copy");
  if (PRICE_IN_COPY_RE.test(`${c.titleFr} ${c.descriptionFr}`)) reasons.push("price_in_copy");
  if (UNSAFE_HTML_RE.test(`${c.descriptionFr} ${c.descriptionEn}`)) reasons.push("unsafe_html");
  for (const tag of ["p", "ul", "li", "h2", "h3", "strong"]) {
    if (tagBalance(c.descriptionFr, tag) !== 0 || tagBalance(c.descriptionEn, tag) !== 0) {
      reasons.push(`unbalanced_html:${tag}`);
      break;
    }
  }
  const brands = forbiddenBrandsIn(all);
  if (brands.length) reasons.push(`supplier_brand:${brands.join(",")}`);
  if (detectDescriptionLanguage(c.descriptionFr).lang !== "FR") reasons.push("description_not_french");
  if (c.titleFr && c.titleFr === c.titleFr.toUpperCase() && /[A-ZÀ-Ý]{6}/.test(c.titleFr)) reasons.push("title_all_caps");

  const bad = unsupportedClaims(`${c.titleFr} ${textOf(c.descriptionFr)}`, product);
  if (bad.length) reasons.push(`unsupported_numbers:${bad.slice(0, 5).join("|")}`);

  return { ok: reasons.length === 0, reasons };
}

// ── Layer 2 ────────────────────────────────────────────────────────────────────────────────────

export type LlmText = (prompt: string, opts?: { images?: Array<{ mediaType: string; data: string }>; tier?: "lite" | "strong" }) => Promise<string>;

/** Default LLM transport: budgetedCreate (so the call is counted on the active pool). */
export const defaultLlmText: LlmText = async (prompt, opts = {}) => {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string } }
  > = [];
  for (const im of opts.images ?? []) {
    content.push({ type: "image", source: { type: "base64", media_type: im.mediaType as "image/jpeg", data: im.data } });
  }
  content.push({ type: "text", text: prompt });
  const message = await budgetedCreate(getAnthropicClient(), {
    model: llmModel(opts.tier ?? "strong"),
    max_tokens: 900,
    messages: [{ role: "user", content }],
  });
  const block = message.content[0];
  return block && block.type === "text" ? block.text : "";
};

function parseJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

interface JudgeOut {
  ok?: boolean;
  issues?: Array<{ type?: string; detail?: string }>;
}

export function buildJudgePrompt(product: AosomMergedProduct, c: GeneratedContent): string {
  const variants = product.variants
    .slice(0, 12)
    .map((v) => [v.color, v.size, v.dimensions ? `${v.dimensions.length}x${v.dimensions.width}x${v.dimensions.height}` : "", v.weight ? `${v.weight}` : ""].filter(Boolean).join(" / "))
    .join("; ");
  return [
    "Tu es un relecteur strict de fiches produit e-commerce. Compare le TEXTE GÉNÉRÉ aux DONNÉES FOURNISSEUR.",
    "Règles: (1) toute affirmation factuelle du texte (dimensions, matériaux, capacité, puissance, nombre de pièces, certifications, garantie, compatibilité) doit figurer dans les données fournisseur; (2) le titre doit décrire le produit des données; (3) aucun nom de fournisseur ni de marque tierce; (4) français correct, sans anglais résiduel; (5) aucune promesse de prix, de livraison ou de garantie.",
    'Réponds UNIQUEMENT en JSON: {"ok":true|false,"issues":[{"type":"invented_fact|wrong_product|brand|language|unsupported_promise","detail":"..."}]}. ok=false dès qu\'une règle est violée.',
    "",
    "DONNÉES FOURNISSEUR:",
    `Nom: ${product.name}`,
    `Catégorie: ${product.productType}`,
    `Matériau: ${product.material || "-"}`,
    `Variantes: ${variants || "-"}`,
    `Description: ${textOf(product.description).slice(0, 3000)}`,
    `Description courte: ${textOf(product.shortDescription).slice(0, 600)}`,
    "",
    "TEXTE GÉNÉRÉ:",
    `Titre FR: ${c.titleFr}`,
    `Description FR: ${textOf(c.descriptionFr).slice(0, 3500)}`,
    `Titre EN: ${c.titleEn}`,
  ].join("\n");
}

/** Independent second reading of the copy. Fail-closed: an unreadable verdict is a failure, not a pass. */
export async function judgeContent(product: AosomMergedProduct, c: GeneratedContent, llm: LlmText = defaultLlmText): Promise<Verdict> {
  let raw: string;
  try {
    raw = await llm(buildJudgePrompt(product, c), { tier: "strong" });
  } catch (err) {
    return { ok: false, reasons: [`judge_unavailable:${err instanceof Error ? err.message.slice(0, 120) : "error"}`] };
  }
  const out = parseJson<JudgeOut>(raw);
  if (!out || typeof out.ok !== "boolean") return { ok: false, reasons: ["judge_unparseable"] };
  const issues = (out.issues ?? []).map((i) => `${i.type ?? "issue"}:${(i.detail ?? "").slice(0, 100)}`);
  if (!out.ok || issues.length > 0) return { ok: false, reasons: issues.length ? issues.map((s) => `judge:${s}`) : ["judge:rejected"] };
  return { ok: true, reasons: [] };
}

export interface FetchedImage {
  mediaType: string;
  data: string;
}

const GALLERY_CHECK_COUNT = 4;
const MAX_IMAGE_BYTES = 4_000_000;

/** Download one gallery image as base64; null when unreachable, empty, not an image, or too large. */
export async function fetchImageBase64(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedImage | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8_000 || buf.length > MAX_IMAGE_BYTES) return null;
    return { mediaType: type, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

interface GalleryOut {
  images?: Array<{ index?: number; supplier_logo?: boolean; watermark?: boolean; not_product?: boolean; unreadable?: boolean }>;
}

/**
 * Gallery photos: reachable (the first GALLERY_CHECK_COUNT must download as real images) and free of
 * supplier logos, watermarks and non-product pictures. The pos-1 "clean photo" rule is enforced elsewhere
 * (import-quality-gates); this looks at the rest of what a shopper scrolls through.
 */
export async function checkGallery(
  images: string[],
  llm: LlmText = defaultLlmText,
  fetchImage: (url: string) => Promise<FetchedImage | null> = fetchImageBase64,
): Promise<Verdict> {
  const urls = [...new Set(images)].slice(0, GALLERY_CHECK_COUNT);
  const fetched: FetchedImage[] = [];
  const reasons: string[] = [];
  for (const [i, u] of urls.entries()) {
    const f = await fetchImage(u);
    if (!f) reasons.push(`image_unreachable:${i + 1}`);
    else fetched.push(f);
  }
  if (reasons.length) return { ok: false, reasons };
  if (fetched.length < Math.min(3, urls.length)) return { ok: false, reasons: ["gallery_too_small"] };

  let raw: string;
  try {
    raw = await llm(
      'Examine ces photos produit dans l\'ordre (index 1..N). Pour chacune indique: supplier_logo (logo ou nom de marque du fournisseur visible), watermark (filigrane), not_product (ne montre pas un produit de maison/jardin/animal/jouet, ex. page de texte, QR code, emballage vide), unreadable (illisible ou trop floue). Réponds UNIQUEMENT en JSON: {"images":[{"index":1,"supplier_logo":false,"watermark":false,"not_product":false,"unreadable":false}]}',
      { images: fetched, tier: "lite" },
    );
  } catch (err) {
    return { ok: false, reasons: [`gallery_judge_unavailable:${err instanceof Error ? err.message.slice(0, 100) : "error"}`] };
  }
  const out = parseJson<GalleryOut>(raw);
  if (!out || !Array.isArray(out.images)) return { ok: false, reasons: ["gallery_unparseable"] };
  for (const im of out.images) {
    const n = im.index ?? "?";
    if (im.supplier_logo) reasons.push(`gallery_supplier_logo:${n}`);
    if (im.watermark) reasons.push(`gallery_watermark:${n}`);
    if (im.not_product) reasons.push(`gallery_not_product:${n}`);
    if (im.unreadable) reasons.push(`gallery_unreadable:${n}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Layer 3 ────────────────────────────────────────────────────────────────────────────────────

const MIN_GALLERY_IMAGES = 3;

export interface ShopifyProductSummary {
  handle: string;
  status: string;
  published: boolean;
  tags: string[];
  imageCount: number;
  variants: Array<{ sku: string; price: number; inventoryManagement: string | null }>;
}

/** What Shopify stores for the freshly created product, compared with what we meant to create. */
export function checkShopifySummary(s: ShopifyProductSummary, product: AosomMergedProduct): Verdict {
  const reasons: string[] = [];
  const expected = new Map(product.variants.map((v) => [v.sku, v.price]));
  if (s.variants.length !== expected.size) reasons.push(`variant_count:${s.variants.length}/${expected.size}`);
  for (const v of s.variants) {
    const floor = expected.get(v.sku);
    if (floor === undefined) reasons.push(`unknown_sku:${v.sku}`);
    else if (!(v.price > 0)) reasons.push(`bad_price:${v.sku}`);
    else if (v.price + 0.005 < floor) reasons.push(`price_below_supplier:${v.sku}`);
    if (v.inventoryManagement) reasons.push(`inventory_tracked:${v.sku}`); // dropship: stock is never tracked in Shopify
  }
  const wantImages = Math.min(MIN_GALLERY_IMAGES, product.images.length);
  if (s.imageCount < wantImages) reasons.push(`images:${s.imageCount}/${wantImages}`);
  if (/aosom/i.test(s.handle)) reasons.push("supplier_in_handle");
  return { ok: reasons.length === 0, reasons };
}
/** The public product page: renders, has a title, a price and an image, and leaks nothing it must not. */
export function checkStorefrontHtml(html: string): Verdict {
  const reasons: string[] = [];
  if (!/<h1[\s>]/i.test(html)) reasons.push("page_no_h1");
  if (!/property=["']og:image["']/i.test(html)) reasons.push("page_no_image");
  if (!/og:price:amount|"price"\s*:|itemprop=["']price["']/i.test(html)) reasons.push("page_no_price");
  const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  const brands = forbiddenBrandsIn(textOf(visible));
  if (brands.length) reasons.push(`page_supplier_brand:${brands.join(",")}`);
  if (/\[BRAND[ _]?NAME\]/i.test(html)) reasons.push("page_template_leftover");
  return { ok: reasons.length === 0, reasons };
}
