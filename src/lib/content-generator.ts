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
  tags: string[];
}

/**
 * Quebec-tuned system prompt, ported from reference aosom-shopify/generator.js.
 */
const SYSTEM_PROMPT = `You are a bilingual e-commerce copywriter specializing in the Quebec/Canada market.
You write product listings in both French (Canadian French) and English.

Rules:
- French must sound natural for Quebec shoppers (not Parisian French)
- Use metric units (cm, kg) — convert if needed
- Do NOT mention shipping or delivery terms
- Include relevant Canadian keywords for SEO
- Keep titles under 80 characters
- HTML body should be clean, mobile-friendly, no inline styles
- Include 5-8 bullet-point features
- Add a short meta description (160 chars max) for each language
- Replace any "[BRAND NAME]" with the actual brand name provided
- Do NOT include color or size info in the title or body (those are variant-level)

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
Brand: ${product.brand}
Category: ${product.productType}
Material: ${product.material}
Price: $${product.variants[0]?.price || 0} CAD
Description: ${cleanDesc.slice(0, 1500)}
Short Description: ${cleanShort.slice(0, 500)}
Variants:
${variantInfo}

Return JSON with this exact structure:
{
  "titleFr": "...",
  "titleEn": "...",
  "descriptionFr": "<HTML product description in French>",
  "descriptionEn": "<HTML product description in English>",
  "seoDescriptionFr": "...",
  "seoDescriptionEn": "...",
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
    return JSON.parse(jsonStr) as GeneratedContent;
  } catch {
    console.error("[content-generator] Claude returned invalid JSON:", text.slice(0, 500));
    throw new Error("Claude returned invalid JSON — check logs for raw response");
  }
}
