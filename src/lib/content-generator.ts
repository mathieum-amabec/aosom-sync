import Anthropic from "@anthropic-ai/sdk";
import type { AosomMergedProduct } from "@/types/aosom";
import { stripColorFromTitle } from "./variant-merger";
import { env, CLAUDE } from "./config";
import { budgetedCreate } from "@/lib/llm-budget";
import { getContentProvider, getContentGeminiModel, getContentGeminiStrongModel } from "./content-provider";
import {
  capTitleWords,
  convertImperialInTitle,
  findImperialOnly,
  findUnaccentedFrench,
  stripColourFromTitle,
  MIN_TAGS,
} from "./content-guards";
import { stripSupplierBrands, detectDescriptionLanguage } from "./catalog-guard";

export { stripSupplierBrands } from "./catalog-guard";

let anthropicClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    // timeout + retries: a network blip must fail fast and retry, never hang the
    // process on a half-open socket (the default has no per-request timeout).
    anthropicClient = new Anthropic({ apiKey: env.anthropicApiKey, timeout: 60_000, maxRetries: 3 });
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

/**
 * Supplier brand names that must never surface in customer-facing output.
 * Mirrors the forbidden list in SYSTEM_PROMPT (the prompt asks Claude to omit
 * them; this is the deterministic backstop). Case-insensitive, so HOMCOM/HomCom
 * and PawHut/Pawhut collapse to one entry each.
 *
 * stripSupplierBrands() itself now lives in ./catalog-guard (shared with the
 * catalog audit script) and is re-exported above for existing callers/tests.
 */

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
- Use metric units (cm, kg) — convert if needed. Never leave an inch, foot or pound value without its
  metric equivalent; titles are metric only.
- Spell every French word with its accents (bébé, sécurité, résistant, étanche).
- Include relevant Canadian keywords for SEO.
- HTML body: clean, mobile-friendly, no inline styles, 5-8 bullet-point features.
- Replace any "[BRAND NAME]" with the actual brand name provided.
- Do NOT mention shipping or delivery in the product title or HTML body.
- Do NOT put color or size in the product title or body (those are variant-level).

PRODUCT TITLE (titleFr / titleEn) — strict pattern:
  [Product type] [distinctive feature] [size/capacity if relevant] — [color if relevant]
  - NEVER include a supplier brand name ANYWHERE in your response: Outsunny, HOMCOM, HomCom, Aosom, Vinsetto, Pawhut,
    PawHut, Soozier, Qaba, ShopEZ, Wikinger, Portland, Aousthop, Costway.
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

TAGS: 8 to 12 short SEO tags, mixing French and English search terms.

Return valid JSON only, no markdown fences.`;

/**
 * Sanitize HTML for both the Aosom INPUT (before Claude) and the Claude OUTPUT
 * (before it is written to Shopify `body_html`, which themes render UNESCAPED).
 * First strips executable/XSS vectors (script/style/iframe/… blocks, `on*=`
 * event handlers, `javascript:`/`vbscript:` URLs) so a prompt-injected feed
 * entry can never land runnable markup on the storefront, then does the content
 * cleanup (inline styles, dash/quote normalization, spec/package sections).
 */
export function sanitizeHtml(html: string): string {
  return html
    // XSS strip (LLM output trust boundary): remove executable elements + handlers.
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "") // on*="..." event handlers
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "") // on*='...' event handlers
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "") // on*=unquoted event handlers
    .replace(/(href|src|xlink:href)\s*=\s*(["'])\s*(?:javascript|vbscript):[^"']*\2/gi, "") // js: URLs
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
 * The model returned something that failed our schema checks — as opposed to the call
 * itself failing (budget exhausted, network, 5xx). Only this class triggers the
 * cheap-model → assistant-model escalation in `generateProductContent`, so a transient
 * infrastructure failure can never silently double the cost of a generation.
 */
export class ContentValidationError extends Error {
  constructor(reason: string) {
    super(`Claude returned invalid content: ${reason}`);
    this.name = "ContentValidationError";
  }
}

/**
 * Generate bilingual FR/EN product content using Claude API.
 */
export async function generateProductContent(
  product: AosomMergedProduct
): Promise<GeneratedContent> {
  const client = getAnthropicClient();

  const cleanName = stripColorFromTitle(product.name);
  const cleanDesc = sanitizeHtml(product.description.replace(/\[BRAND NAME\]/gi, "Ameublo Direct"));
  const cleanShort = sanitizeHtml(product.shortDescription.replace(/\[BRAND NAME\]/gi, "Ameublo Direct"));

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

  // Model chain (CONTENT_PROVIDER, see content-provider.ts). Only a ContentValidationError moves
  // down the chain: a budget-exceeded or network failure must not buy a second paid call.
  //   gemini mode (default): Gemini Flash-Lite -> Gemini 3.8 Flash  (no Claude in the path)
  //   anthropic mode:        Claude Haiku      -> Claude Sonnet     (the historical chain)
  // budgetedCreate serves a gemini-* model with Google and returns the same Message shape, so one
  // code path handles both. The same prompt, validation and guardrails apply whichever model
  // wrote the draft.
  //
  // `correction` is set on the single same-tier retry that fixes soft problems (inch values left
  // in the body, missing accents, too few tags) — see collectCopyIssues below.
  type Tier = "first" | "second";
  const tiers: Tier[] = ["first", "second"];
  const gemini = getContentProvider() === "gemini";
  const modelFor = (t: Tier) =>
    gemini
      ? t === "first" ? getContentGeminiModel() : getContentGeminiStrongModel()
      : t === "first" ? CLAUDE.MODEL_BATCH : CLAUDE.MODEL;
  const attempt = async (tier: Tier, correction?: string): Promise<GeneratedContent> => {
    const model = modelFor(tier);
    const userPrompt = correction ? `${prompt}

${correction}` : prompt;

    const message = await budgetedCreate(client, {
      model,
      max_tokens: CLAUDE.MAX_TOKENS_CONTENT,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    if (!message.content.length || message.content[0].type !== "text" || !message.content[0].text.trim()) {
      throw new ContentValidationError("empty or non-text content (possible refusal)");
    }
    const text = message.content[0].text;
    const jsonStr = text.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

    let content: GeneratedContent;
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
      parsed.tags = parsed.tags
        .filter((t: unknown): t is string => typeof t === "string")
        // Tags were the one field the brand strip never reached: a "costway" / "outsunny" tag would be
        // public on the storefront. A tag that IS a brand collapses to "" and is dropped.
        .map((t: string) => stripSupplierBrands(t).replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 20);

      // Programmatic safety net: strip supplier brand names the model may still echo
      // into titles. Runs before length/meta/handle derivation so those stay clean too.
      // Uses the shared stripSupplierBrands() helper (also applied to URL handles below);
      // collapse the whitespace gaps it leaves behind so titles don't keep double spaces.
      parsed.titleFr = stripSupplierBrands(parsed.titleFr).replace(/\s+/g, " ").trim();
      parsed.titleEn = stripSupplierBrands(parsed.titleEn).replace(/\s+/g, " ").trim();

      // Title guardrails (content-guards.ts): the prompt's own rules, enforced in code because
      // every model slips on them some of the time. Order matters: convert inch/foot values
      // first (so a dimension reads as one unit), then drop the colour, then cap the length.
      const multiColour = new Set(product.variants.map((v) => v.color).filter(Boolean)).size > 1;
      for (const [key, locale] of [["titleFr", "fr"], ["titleEn", "en"]] as const) {
        parsed[key] = capTitleWords(
          stripColourFromTitle(convertImperialInTitle(parsed[key], locale), multiColour),
        );
      }

      // Enforce length / format limits
      parsed.titleFr = parsed.titleFr.slice(0, 200);
      parsed.titleEn = parsed.titleEn.slice(0, 200);
      // LLM output trust boundary: sanitize the model's HTML (same allow-list as the
      // input) BEFORE it is persisted to Shopify body_html / custom.body_html_en.
      // stripSupplierBrands() runs on descriptions too, not just titles/handles — the
      // system prompt asks the model to omit the supplier name, but that is a soft
      // instruction; this is the deterministic backstop the titles already had.
      parsed.descriptionFr = stripSupplierBrands(sanitizeHtml(parsed.descriptionFr)).slice(0, 10000);
      parsed.descriptionEn = stripSupplierBrands(sanitizeHtml(parsed.descriptionEn)).slice(0, 10000);
      parsed.seoDescriptionFr = stripSupplierBrands(parsed.seoDescriptionFr).slice(0, 200);
      parsed.seoDescriptionEn = stripSupplierBrands(parsed.seoDescriptionEn).slice(0, 200);
      parsed.metaTitleFr = clampMetaTitle(parsed.metaTitleFr, 65);
      parsed.metaTitleEn = clampMetaTitle(parsed.metaTitleEn, 65);
      parsed.metaDescriptionFr = parsed.metaDescriptionFr.slice(0, 155);
      parsed.metaDescriptionEn = parsed.metaDescriptionEn.slice(0, 155);
      parsed.urlHandleFr = slugify(stripSupplierBrands(parsed.urlHandleFr));
      parsed.urlHandleEn = slugify(stripSupplierBrands(parsed.urlHandleEn));

      // Supplier brand is echoed from the source (never invented by the model) so it
      // can be the Shopify vendor + stored in custom.brand_fr.
      parsed.brand = product.brand;

      // Language backstop: descriptionFr must actually read as French. This is the
      // write-time guard against the description-language class of bug (679/1382
      // active products went English via a since-fixed diff-engine defect) — a model
      // that returns English (or an empty/unparseable body) for descriptionFr must
      // never reach Shopify silently. Throwing ContentValidationError here reuses the
      // existing MODEL_BATCH → MODEL escalation below: a cheap-tier slip retries on
      // the stronger model before this ever surfaces to the caller.
      const frLang = detectDescriptionLanguage(parsed.descriptionFr);
      if (frLang.lang === "EN" || frLang.lang === "empty") {
        throw new ContentValidationError(
          `descriptionFr does not read as French (detected: ${frLang.lang}, fr=${frLang.fr} en=${frLang.en})`,
        );
      }

      content = parsed as GeneratedContent;
    } catch (err) {
      // Name the model: with two tiers in play, "invalid content" is only actionable if
      // the log says which model produced it.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[content-generator] ${model} returned invalid content (${reason}):`, text.slice(0, 500));
      throw new ContentValidationError(`invalid or incomplete JSON payload from ${model}`);
    }

    // Soft problems (inch values left in the body, missing accents, too few tags). These are
    // fixable by the SAME model in one cheap extra call, so they never escalate to the paid tier
    // and are handled OUTSIDE the try above — a budget/network failure on the retry must
    // propagate as itself, not be relabelled a validation error (which would buy an escalation).
    const issues = collectCopyIssues(content);
    if (issues.length && !correction) {
      console.warn(`[content-generator] ${model} copy needs a fix (${issues.join("; ")}) — one corrective retry`);
      return attempt(tier, buildCorrection(issues));
    }
    if (issues.length) {
      console.warn(`[content-generator] ${model} still has issues after the corrective retry — keeping the draft: ${issues.join("; ")}`);
    }
    return content;
  };

  for (let i = 0; ; i++) {
    try {
      return await attempt(tiers[i]);
    } catch (err) {
      // Only a validation failure moves down the chain; an API/budget/network error propagates.
      if (!(err instanceof ContentValidationError)) throw err;
      // Skip any tier configured to the SAME model (e.g. CLAUDE_BATCH_MODEL set to Sonnet):
      // re-running the same model on the same prompt is a paid no-op.
      let next = i + 1;
      while (next < tiers.length && modelFor(tiers[next]) === modelFor(tiers[i])) next++;
      if (next >= tiers.length) throw err;
      console.warn(
        `[content-generator] ${modelFor(tiers[i])} output rejected (${err.message}) — ` +
          `re-running "${cleanName}" on ${modelFor(tiers[next])}`,
      );
      i = next - 1;
    }
  }
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Soft problems in an otherwise valid listing, as short human-readable lines (empty = clean).
 * Titles are NOT checked here — they are repaired deterministically before this runs.
 */
export function collectCopyIssues(c: GeneratedContent): string[] {
  const issues: string[] = [];
  const imperial = findImperialOnly(
    [c.descriptionFr, c.descriptionEn, c.seoDescriptionFr, c.seoDescriptionEn].map(stripTags).join(" . "),
  );
  if (imperial.length) {
    issues.push(`imperial values without a metric equivalent: ${imperial.slice(0, 6).join(", ")}`);
  }
  const accents = findUnaccentedFrench(
    [c.titleFr, stripTags(c.descriptionFr), c.metaTitleFr, c.metaDescriptionFr, c.seoDescriptionFr].join(" . "),
  );
  if (accents.length) issues.push(`French words missing accents: ${accents.slice(0, 6).join(", ")}`);
  if (c.tags.length < MIN_TAGS) issues.push(`only ${c.tags.length} tags (need 8 to 12)`);
  return issues;
}

/** The follow-up message for the one same-tier corrective retry. */
function buildCorrection(issues: string[]): string {
  return (
    "Your previous answer was valid JSON but had these problems:\n" +
    issues.map((i) => `- ${i}`).join("\n") +
    "\nReturn the COMPLETE JSON again, fixing exactly these. Give metric values (cm, m, kg) — you may keep " +
    "the original imperial value in parentheses after the metric one. Keep everything else unchanged."
  );
}
