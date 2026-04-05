import Anthropic from "@anthropic-ai/sdk";
import type { AosomMergedProduct } from "@/types/aosom";
import { stripColorFromTitle } from "./variant-merger";

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

const REQUIRED_FIELDS: (keyof GeneratedContent)[] = [
  "titleFr", "titleEn", "descriptionFr", "descriptionEn",
  "seoDescriptionFr", "seoDescriptionEn", "tags",
];

function validateContent(data: unknown): GeneratedContent {
  if (!data || typeof data !== "object") {
    throw new Error("Claude returned non-object response");
  }
  const obj = data as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  if (!Array.isArray(obj.tags)) {
    throw new Error("tags must be an array");
  }
  return obj as unknown as GeneratedContent;
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

function buildPrompt(product: AosomMergedProduct): string {
  const cleanName = stripColorFromTitle(product.name);
  const cleanDesc = sanitizeHtml(product.description.replace(/\[BRAND NAME\]/gi, product.brand));
  const cleanShort = sanitizeHtml(product.shortDescription.replace(/\[BRAND NAME\]/gi, product.brand));

  const variantInfo = product.variants
    .map((v) => `- SKU: ${v.sku}, Price: $${v.price}`)
    .join("\n");

  return `Create a Shopify product listing from this data:

Name: ${cleanName}
Brand: ${product.brand}
Category: ${product.productType}
Material: ${product.material}
Price: $${product.variants[0]?.price || 0} CAD
Description: ${cleanDesc.slice(0, 1500)}${cleanDesc.length > 1500 ? " [truncated]" : ""}
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
}

const MAX_GENERATE_ATTEMPTS = 2;

/**
 * Generate bilingual FR/EN product content using Claude API.
 * Retries once on JSON parse failure.
 */
export async function generateProductContent(
  product: AosomMergedProduct
): Promise<GeneratedContent> {
  const client = getClient();
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const prompt = buildPrompt(product);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const message = await client.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";

    try {
      const jsonStr = text.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(jsonStr);
      return validateContent(parsed);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // On first failure, the retry will naturally re-prompt Claude
    }
  }

  throw new Error(`Failed to parse Claude response after ${MAX_GENERATE_ATTEMPTS} attempts: ${lastError?.message}`);
}
