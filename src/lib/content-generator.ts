import Anthropic from "@anthropic-ai/sdk";
import type { AosomMergedProduct } from "@/types/aosom";
import { stripColorFromTitle } from "./variant-merger";
import { env, CLAUDE } from "./config";

let anthropicClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: env.anthropicApiKey });
  }
  return anthropicClient;
}

export interface GeneratedContent {
  titleFr: string;
  titleEn: string;
  descriptionFr: string;
  descriptionEn: string;
  seoDescriptionFr: string;
  seoDescriptionEn: string;
  // SEO-native fields (Shopify global.title_tag / global.description_tag + handle)
  metaTitleFr: string;
  metaTitleEn: string;
  metaDescriptionFr: string;
  metaDescriptionEn: string;
  urlHandleFr: string;
  urlHandleEn: string;
  tags: string[];
  /** Supplier brand (Outsunny, HOMCOM, …) — internal only, used as Shopify vendor; never in the title. */
  brand: string;
}

/**
 * Kebab-case slug: lowercase, accent-stripped, alphanumerics joined by hyphens.
 * Defensive — guarantees a clean handle regardless of what the model returns.
 */
/**
 * Clamp a "Name | suffix — Brand" meta title to `max` chars WITHOUT cutting the
 * brand suffix. If too long, trim the name part (at a word boundary) and keep the
 * full "| … — Brand" tail. Falls back to a plain tail-slice if there is no " | ".
 */
export function clampMetaTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  const sepIdx = title.indexOf(" | ");
  if (sepIdx === -1) return title.slice(0, max);
  const suffix = title.slice(sepIdx); // " | Livraison gratuite — Ameublo Direct"
  const room = max - suffix.length;
  if (room <= 3) return title.slice(0, max); // suffix alone ~fills the budget
  let name = title.slice(0, room);
  const lastSpace = name.lastIndexOf(" ");
  if (lastSpace > 0) name = name.slice(0, lastSpace);
  return name.trimEnd() + suffix;
}

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (é → e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * Backfill the SEO-native fields (metaTitle, metaDescription, urlHandle, brand)
 * on content that was persisted BEFORE product-naming-v2. Import jobs generated
 * under the old schema lack these fields, so without this they reach Shopify as
 * `undefined` metafield values and 422 the whole product create. Only empty
 * fields are filled — anything the model already produced is left untouched.
 */
export function backfillSeoFields(content: GeneratedContent, brand: string): GeneratedContent {
  const c = { ...content };
  const empty = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

  if (empty(c.brand)) c.brand = brand;
  if (empty(c.metaTitleFr)) c.metaTitleFr = clampMetaTitle(`${c.titleFr} | Livraison gratuite — Ameublo Direct`, 65);
  if (empty(c.metaTitleEn)) c.metaTitleEn = clampMetaTitle(`${c.titleEn} | Free Shipping — Furnish Direct`, 65);
  if (empty(c.metaDescriptionFr)) c.metaDescriptionFr = (c.seoDescriptionFr || c.titleFr).slice(0, 155);
  if (empty(c.metaDescriptionEn)) c.metaDescriptionEn = (c.seoDescriptionEn || c.titleEn).slice(0, 155);
  if (empty(c.urlHandleFr)) c.urlHandleFr = slugify(c.titleFr);
  if (empty(c.urlHandleEn)) c.urlHandleEn = slugify(c.titleEn);
  return c;
}

/**
 * Quebec-tuned system prompt, ported from reference aosom-shopify/generator.js.
 */
const SYSTEM_PROMPT = `You are a bilingual e-commerce copywriter for a Quebec/Canada furniture store.
You write product listings in Canadian French and English.

GLOBAL RULES
- French must sound natural for Quebec shoppers (not Parisian French).
- Use metric units (cm, kg) — convert if needed.
- Include relevant Canadian keywords for SEO.
- HTML body: clean, mobile-friendly, no inline styles, 5-8 bullet-point features.
- Replace any "[BRAND NAME]" with the actual brand name provided.
- Do NOT mention shipping or delivery in the product title or HTML body.
- Do NOT put color or size in the product title or body (those are variant-level).

PRODUCT TITLE (titleFr / titleEn) — strict pattern:
  [Product type] [distinctive feature] [size/capacity if relevant] — [color if relevant]
  - NEVER include a supplier brand: Outsunny, HOMCOM, HomCom, Aosom, Vinsetto, Pawhut,
    PawHut, Soozier, Qaba, ShopEZ, Wikinger, Portland, Aousthop.
  - Maximum 10 words, strict — truncate if necessary. Product type FIRST (SEO). No brand, no model number.
  - Color, only if relevant, after an em dash "—".

META TITLE (metaTitleFr / metaTitleEn) — max 65 characters total:
  - FR pattern: "<product name FR> | Livraison gratuite — Ameublo Direct"
  - EN pattern: "<product name EN> | Free Shipping — Furnish Direct"
  - Keep the product-name part short so the whole string stays within 65 characters.

META DESCRIPTION (metaDescriptionFr / metaDescriptionEn) — max 155 characters:
  - Lead with the main benefit, mention free shipping in Canada, end with a short CTA.
  - (Meta title/description are the ONLY place shipping may be mentioned.)

URL HANDLE (urlHandleFr / urlHandleEn):
  - Short kebab-case slug: lowercase, no accents, no supplier brand, words joined by "-".
  - Example: "chaise-longue-reglable-grise".

Return valid JSON only, no markdown fences.`;

/**
 * Sanitize Aosom HTML before passing to Claude.
 * Strips inline styles, normalizes bullet characters, removes spec tables.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/\s*style="[^"]*"/gi, "") // strip inline styles
    .replace(/\u2013|\u2014/g, "-") // normalize dashes
    .replace(/\u2018|\u2019/g, "'") // normalize quotes
    .replace(/\u201c|\u201d/g, '"')
    .replace(/<h3>\s*Specification[s]?:?\s*<\/h3>[\s\S]*?(?=<h3>|$)/gi, "") // remove spec section
    .replace(/<h3>\s*Package Includes:?\s*<\/h3>[\s\S]*?(?=<h3>|$)/gi, "") // remove package section
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generate bilingual FR/EN product content using Claude API.
 */
export async function generateProductContent(
  product: AosomMergedProduct
): Promise<GeneratedContent> {
  const client = getAnthropicClient();

  const cleanName = stripColorFromTitle(product.name);
  const cleanDesc = sanitizeHtml(product.description.replace(/\[BRAND NAME\]/gi, product.brand));
  const cleanShort = sanitizeHtml(product.shortDescription.replace(/\[BRAND NAME\]/gi, product.brand));

  const variantInfo = product.variants
    .map((v) => `- SKU: ${v.sku}, Price: $${v.price}`)
    .join("\n");

  const prompt = `Create a Shopify product listing from this data:

Name: ${cleanName}
Brand (supplier — internal only, NEVER put it in the title): ${product.brand}
Category: ${product.productType}
Material: ${product.material}
Price: $${product.variants[0]?.price || 0} CAD
Description: ${cleanDesc.slice(0, 1500)}
Short Description: ${cleanShort.slice(0, 500)}
Variants:
${variantInfo}

Store brands for the meta titles: French store = "Ameublo Direct", English store = "Furnish Direct".

Return JSON with this exact structure:
{
  "titleFr": "...",
  "titleEn": "...",
  "descriptionFr": "<HTML product description in French>",
  "descriptionEn": "<HTML product description in English>",
  "seoDescriptionFr": "...",
  "seoDescriptionEn": "...",
  "metaTitleFr": "<= 65 chars, pattern: name FR | Livraison gratuite — Ameublo Direct",
  "metaTitleEn": "<= 65 chars, pattern: name EN | Free Shipping — Furnish Direct",
  "metaDescriptionFr": "<= 155 chars, benefit + livraison gratuite + CTA",
  "metaDescriptionEn": "<= 155 chars, benefit + free shipping + CTA",
  "urlHandleFr": "kebab-case-fr-no-accents-no-brand",
  "urlHandleEn": "kebab-case-en-no-accents-no-brand",
  "tags": ["tag1", "tag2"]
}`;

  const message = await client.messages.create({
    model: CLAUDE.MODEL,
    max_tokens: CLAUDE.MAX_TOKENS_CONTENT,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  if (!message.content.length || message.content[0].type !== "text" || !message.content[0].text.trim()) {
    throw new Error("Claude returned empty or non-text content (possible refusal)");
  }

  const text = message.content[0].text;
  const jsonStr = text.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  try {
    const parsed = JSON.parse(jsonStr);
    // Validate required string fields (LLM output trust boundary)
    const stringFields = [
      "titleFr", "titleEn", "descriptionFr", "descriptionEn",
      "seoDescriptionFr", "seoDescriptionEn",
      "metaTitleFr", "metaTitleEn", "metaDescriptionFr", "metaDescriptionEn",
      "urlHandleFr", "urlHandleEn",
    ] as const;
    for (const field of stringFields) {
      if (typeof parsed[field] !== "string") throw new Error(`Missing or invalid field: ${field}`);
    }
    if (!Array.isArray(parsed.tags)) throw new Error("Missing or invalid field: tags");
    parsed.tags = parsed.tags.filter((t: unknown) => typeof t === "string").slice(0, 20);

    // Enforce length / format limits
    parsed.titleFr = parsed.titleFr.slice(0, 200);
    parsed.titleEn = parsed.titleEn.slice(0, 200);
    parsed.descriptionFr = parsed.descriptionFr.slice(0, 10000);
    parsed.descriptionEn = parsed.descriptionEn.slice(0, 10000);
    parsed.seoDescriptionFr = parsed.seoDescriptionFr.slice(0, 200);
    parsed.seoDescriptionEn = parsed.seoDescriptionEn.slice(0, 200);
    parsed.metaTitleFr = clampMetaTitle(parsed.metaTitleFr, 65);
    parsed.metaTitleEn = clampMetaTitle(parsed.metaTitleEn, 65);
    parsed.metaDescriptionFr = parsed.metaDescriptionFr.slice(0, 155);
    parsed.metaDescriptionEn = parsed.metaDescriptionEn.slice(0, 155);
    parsed.urlHandleFr = slugify(parsed.urlHandleFr);
    parsed.urlHandleEn = slugify(parsed.urlHandleEn);

    // Supplier brand is echoed from the source (never invented by the model) so it
    // can be the Shopify vendor + stored in custom.brand_fr.
    parsed.brand = product.brand;

    return parsed as GeneratedContent;
  } catch (err) {
    console.error("[content-generator] Claude returned invalid content:", text.slice(0, 500));
    throw new Error("Claude returned invalid content");
  }
}
