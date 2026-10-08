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
import { isLicensedName } from "./policy";
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
/** An imperial equivalent right after a metric value, e.g. "30 kg (66 lb)": the house style, not an untranslated unit. */
const IMPERIAL_EQUIVALENT_RE =
  /\d(?:[.,]\d+)?\s?(?:kg|g|cm|mm|m|l|ml)\s?\(\s*\d+(?:[.,]\d+)?\s?(?:inches|inch|lbs?|pounds|ounces|oz|feet|ft|gallons?|gal|po|pi)\s?\)/gi;
export const stripImperialEquivalents = (s: string): string => s.replace(IMPERIAL_EQUIVALENT_RE, (m) => m.slice(0, m.indexOf("(")));
const PRICE_IN_COPY_RE =/\b\d{1,5}(?:[.,]\d{2})\s?\$|\$\s?\d{1,5}(?:[.,]\d{2})?\b/;
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
  if (ENGLISH_UNIT_RE.test(stripImperialEquivalents(`${c.titleFr} ${c.descriptionFr}`))) reasons.push("english_units_in_french_copy");
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

export type LlmText = (prompt: string, opts?: { images?: Array<{ mediaType: string; data: string }>; tier?: "lite" | "strong"; maxTokens?: number }) => Promise<string>;

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
    max_tokens: opts.maxTokens ?? 900,
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
  title_ok?: boolean;
  issues?: Array<{ type?: string; detail?: string }>;
}

export function buildJudgePrompt(product: AosomMergedProduct, c: GeneratedContent): string {
  const variants = product.variants
    .slice(0, 12)
    .map((v) => [v.color, v.size, v.dimensions ? `${v.dimensions.length}x${v.dimensions.width}x${v.dimensions.height}` : "", v.weight ? `${v.weight}` : ""].filter(Boolean).join(" / "))
    .join("; ");
  return [
    "Tu es un relecteur strict de fiches produit e-commerce. Compare le TEXTE GÉNÉRÉ aux DONNÉES FOURNISSEUR.",
    "Règles: (1) toute affirmation factuelle du texte (dimensions, matériaux, capacité, puissance, nombre de pièces, certifications, garantie, compatibilité) doit figurer dans les données fournisseur; (2) le titre doit décrire le produit des données; (3) aucun nom de fournisseur ni de marque tierce; (4) français correct, sans anglais résiduel; (5) aucune promesse de prix, de livraison ou de garantie; (6) le TITRE FR a du sens pour un client québécois: il nomme clairement le type de produit (pas seulement des mots-clés), se lit naturellement en français, ne contient aucun nom d'entreprise ou de marque et ne répète pas de mots.",
    'Réponds UNIQUEMENT en JSON: {"ok":true|false,"title_ok":true|false,"issues":[{"type":"invented_fact|wrong_product|brand|language|unsupported_promise|title","detail":"..."}]}. ok=false dès qu\'une règle est violée; title_ok=false si la règle (6) est violée.',
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
  const reasons = issues.map((s) => `judge:${s}`);
  if (out.title_ok === false && !reasons.some((r) => r.startsWith("judge:title"))) reasons.push("judge:title_not_sensible");
  if (!out.ok && reasons.length === 0) reasons.push("judge:rejected");
  return { ok: reasons.length === 0, reasons };
}

export interface FetchedImage {
  mediaType: string;
  data: string;
}

/** Photos examined per product: the first six cover everything a shopper sees before scrolling. */
const GALLERY_ANALYZE_COUNT = 6;
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
  images?: Array<{
    index?: number;
    supplier_logo?: boolean;
    watermark?: boolean;
    not_product?: boolean;
    unreadable?: boolean;
    lifestyle?: boolean;
    text_overlay?: boolean;
  }>;
}

export interface GalleryFlag {
  /** 1-based position in the analysed list. */
  index: number;
  url: string;
  supplierLogo: boolean;
  watermark: boolean;
  notProduct: boolean;
  unreadable: boolean;
  /** An in-use scene (room, garden, pet at home…) rather than the product alone on a plain background. */
  lifestyle: boolean;
  /** Marketing text / dimension callouts burned onto the photo. */
  textOverlay: boolean;
}

export interface GalleryAnalysis {
  ok: boolean;
  reasons: string[];
  flags: GalleryFlag[];
  /** Photos that could not be downloaded as real images. */
  unreachable: string[];
}

/**
 * One vision call over the first photos: which show a supplier logo / watermark / no product, which are
 * lifestyle scenes, which carry burned-in text. Fail-closed when the model cannot answer; does NOT decide
 * what to do with the answers — see cleanGallery.
 */
export async function analyzeGallery(
  images: string[],
  llm: LlmText = defaultLlmText,
  fetchImage: (url: string) => Promise<FetchedImage | null> = fetchImageBase64,
): Promise<GalleryAnalysis> {
  const urls = [...new Set(images)].slice(0, GALLERY_ANALYZE_COUNT);
  const reachable: Array<{ url: string; img: FetchedImage }> = [];
  const unreachable: string[] = [];
  for (const u of urls) {
    const img = await fetchImage(u);
    if (img) reachable.push({ url: u, img });
    else unreachable.push(u);
  }
  if (reachable.length < Math.min(3, urls.length)) {
    return { ok: false, reasons: [`gallery_too_few_reachable:${reachable.length}/${urls.length}`], flags: [], unreachable };
  }

  let raw: string;
  try {
    raw = await llm(
      `Examine ces ${reachable.length} photos produit dans l'ordre (index 1..${reachable.length}). Pour chacune indique: supplier_logo (logo ou nom de marque du fournisseur visible), watermark (filigrane), not_product (ne montre pas le produit: page de texte, QR code, emballage vide), unreadable (illisible ou trop floue), lifestyle (le produit est montré en situation réelle: pièce meublée, jardin, animal, enfant qui l'utilise; false si le produit est seul sur fond uni ou blanc), text_overlay (texte marketing, flèches ou cotes de dimensions incrustés sur la photo). Réponds UNIQUEMENT en JSON: {"images":[{"index":1,"supplier_logo":false,"watermark":false,"not_product":false,"unreadable":false,"lifestyle":true,"text_overlay":false}]}`,
      { images: reachable.map((r) => r.img), tier: "lite" },
    );
  } catch (err) {
    return { ok: false, reasons: [`gallery_judge_unavailable:${err instanceof Error ? err.message.slice(0, 100) : "error"}`], flags: [], unreachable };
  }
  const out = parseJson<GalleryOut>(raw);
  if (!out || !Array.isArray(out.images)) return { ok: false, reasons: ["gallery_unparseable"], flags: [], unreachable };
  const flags: GalleryFlag[] = reachable.map((r, i) => {
    const o = out.images!.find((x) => x.index === i + 1) ?? {};
    return {
      index: i + 1,
      url: r.url,
      supplierLogo: !!o.supplier_logo,
      watermark: !!o.watermark,
      notProduct: !!o.not_product,
      unreadable: !!o.unreadable,
      lifestyle: !!o.lifestyle,
      textOverlay: !!o.text_overlay,
    };
  });
  return { ok: true, reasons: [], flags, unreachable };
}

export interface CleanedGallery {
  images: string[];
  dropped: string[];
  /** The photo now in position 1 came from further down the gallery. */
  promoted: boolean;
  /** A clean lifestyle scene exists among the analysed photos (and leads the gallery when promoted). */
  hasLifestyle: boolean;
  reasons: string[];
}

const isBad = (f: GalleryFlag) => f.supplierLogo || f.watermark || f.notProduct || f.unreadable;

/**
 * Turn the analysis into the gallery we actually publish: photos with a supplier logo, a watermark or no
 * product are dropped (and unreachable ones), then the position-1 photo is chosen — a CLEAN lifestyle scene
 * when one exists (shoppers see the product in use first), otherwise the first photo without burned-in text
 * (the studio shot). Fails only when fewer than `minKeep` usable photos remain.
 */
export function cleanGallery(images: string[], a: GalleryAnalysis, minKeep = 3): CleanedGallery {
  const byUrl = new Map(a.flags.map((f) => [f.url, f]));
  const dropped = [...a.unreachable, ...a.flags.filter(isBad).map((f) => f.url)];
  let kept = images.filter((u) => !dropped.includes(u));
  if (kept.length < minKeep) {
    return { images: kept, dropped, promoted: false, hasLifestyle: false, reasons: [`gallery_too_few_clean_photos:${kept.length}`] };
  }
  const clean = (u: string) => {
    const f = byUrl.get(u);
    return !!f && !f.textOverlay;
  };
  const lifestyle = kept.find((u) => byUrl.get(u)?.lifestyle && clean(u));
  let pick: string | undefined = lifestyle;
  if (!pick && !clean(kept[0])) pick = kept.find(clean);
  let promoted = false;
  if (pick && pick !== kept[0]) {
    kept = [pick, ...kept.filter((u) => u !== pick)];
    promoted = true;
  }
  const reasons: string[] = [];
  if (!lifestyle && !clean(kept[0])) reasons.push("no_clean_primary_photo");
  return { images: kept, dropped, promoted, hasLifestyle: !!lifestyle, reasons };
}

// ── Titles and colour photos ───────────────────────────────────────────────────────────────────

/** Short uppercase words that are product vocabulary, not company names. */
const TITLE_ALLOWED_CAPS = new Set([
  "LED", "DEL", "USB", "HDMI", "PVC", "TV", "WIFI", "RGB", "UV", "LCD", "BBQ", "PRO", "XXL", "XL", "SPA", "GPS", "DIY", "ABS", "MDF", "PET", "ECO", "HD", "AC", "DC", "OK",
  "CSA", "UL", "FSC", "BPA", "HEPA", "NFC", "BT", "DVD", "CD", "RV", "ATV", "UTV", "SUV",
]);

/** Company-looking tokens: CamelCase with an inner capital (PawHut, HomCom) or long all-caps words. */
export function companyLikeTokens(title: string): string[] {
  const out: string[] = [];
  for (const raw of title.split(/[\s/,;:()+]+/)) {
    const t = raw.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, "");
    if (t.length < 4) continue;
    if (/^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(t)) out.push(t);
    else if (/^[A-ZÀ-Ý]{4,}$/.test(t) && !TITLE_ALLOWED_CAPS.has(t)) out.push(t);
  }
  return out;
}

export function checkTitle(product: AosomMergedProduct, c: GeneratedContent): Verdict {
  const reasons: string[] = [];
  for (const [lang, title] of [["fr", c.titleFr], ["en", c.titleEn]] as const) {
    const t = (title || "").trim();
    if (t.length < (lang === "fr" ? 25 : 15) || t.length > 110) reasons.push(`title_${lang}_length:${t.length}`);
    if (t.split(/\s+/).length < 3) reasons.push(`title_${lang}_too_few_words`);
    if (/[-–—,:|(&]$|\.{3}$|…$/.test(t)) reasons.push(`title_${lang}_truncated`);
    if (/^[a-zà-ÿ]/.test(t)) reasons.push(`title_${lang}_starts_lowercase`);
    if (/&amp;|&nbsp;|<|>|\|/.test(t)) reasons.push(`title_${lang}_markup`);
    if (/ameublo|furnish direct|aosom/i.test(t)) reasons.push(`title_${lang}_store_or_supplier_name`);
    const brands = forbiddenBrandsIn(t);
    if (brands.length) reasons.push(`title_${lang}_supplier_brand:${brands.join(",")}`);
    if (isLicensedName(t)) reasons.push(`title_${lang}_third_party_brand`);
    const brand = (product.brand || "").trim();
    if (brand.length >= 3 && new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)) {
      reasons.push(`title_${lang}_has_product_brand:${brand}`);
    }
    const tokens = companyLikeTokens(t);
    if (tokens.length) reasons.push(`title_${lang}_company_like_token:${tokens.slice(0, 3).join("|")}`);
    const words = t.toLowerCase().match(/[a-zà-ÿ]{4,}/g) ?? [];
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    if ([...counts.values()].some((n) => n >= 3)) reasons.push(`title_${lang}_repeated_word`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Colour swatches change the photo only when each colour owns a photo in the gallery (that is what gets
 * attached to its variants at creation). Every colour must have one, and a product in several colours
 * must not point them all at the same picture.
 */
export function checkColorPhotos(product: AosomMergedProduct): Verdict {
  const colours = new Map<string, number>();
  for (const v of product.variants) {
    const key = (v.color || "").trim().toLowerCase();
    if (!key) continue;
    const idx = v.images.map((u) => product.images.indexOf(u)).find((i) => i >= 0);
    const prev = colours.get(key);
    if (prev === undefined || (prev < 0 && idx !== undefined && idx >= 0)) colours.set(key, idx ?? -1);
  }
  if (colours.size < 2) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  for (const [colour, idx] of colours) if (idx < 0) reasons.push(`color_without_photo:${colour}`);
  const distinct = new Set([...colours.values()].filter((i) => i >= 0));
  if (distinct.size < 2) reasons.push("colors_share_one_photo");
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
  variants: Array<{ sku: string; price: number; inventoryManagement: string | null; imageId?: number | null }>;
}

/** What Shopify stores for the freshly created product, compared with what we meant to create. */
export function checkShopifySummary(s: ShopifyProductSummary, product: AosomMergedProduct): Verdict {
  const reasons: string[] = [];
  const expected = new Map(product.variants.map((v) => [v.sku, v.price]));
  // Colour swatches: when the product has several colours with their own photos, each colour variant must
  // carry an image id on Shopify (that is what makes the swatch change the photo), and not all the same one.
  const colourOf = new Map(product.variants.map((v) => [v.sku, (v.color || "").trim().toLowerCase()]));
  const colours = new Set([...colourOf.values()].filter(Boolean));
  if (colours.size >= 2 && checkColorPhotos(product).ok) {
    const coloured = s.variants.filter((v) => colourOf.get(v.sku));
    for (const v of coloured) if (!v.imageId) reasons.push(`variant_without_photo:${v.sku}`);
    const distinct = new Set(coloured.map((v) => v.imageId).filter(Boolean));
    if (distinct.size < 2) reasons.push("swatches_do_not_change_photo");
  }
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
