/**
 * Vision-based pos-1 image compliance classifier.
 *
 * A compliant primary (pos-1) product image is a clean photo with NO marketing text
 * overlay burned onto it (slogans, prices, badges, callouts, added logos). Text that is
 * DIEGETIC — physically part of the photographed scene or product (a brand engraved on
 * the item, a book title on a shelf, third-party packaging in the room) — does NOT make
 * an image non-compliant.
 *
 * This is the automated equivalent of the 141 manual pos-1 swaps: the strict prompt below
 * is the same validated one used for that pass (marketing overlay only, diegetic excluded).
 */
import { getAnthropicClient } from "./content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { CLAUDE } from "./config";

export interface ImageClassification {
  /** true = clean primary image (no marketing text overlay). */
  compliant: boolean;
  /** One short sentence explaining the verdict (from the model, trimmed). */
  reason: string;
  /**
   * Model self-reported confidence, 0..1, when it returned a usable number.
   *
   * The prompt has always asked for this and the parser always threw it away. It is kept now
   * because hybrid mode needs it: a low-confidence verdict is exactly the case a human should
   * see rather than have applied automatically. `undefined` means "not reported" — or a row
   * cached before this existed — and must NEVER be read as low confidence.
   */
  confidence?: number;
}

/**
 * Strict, validated system prompt. Sole job: detect MARKETING text overlay incrusted on
 * top of the photo, while treating diegetic text as clean. Quebec French, JSON-only.
 */
export const STRICT_OVERLAY_PROMPT = `Tu es un classificateur d'images e-commerce STRICT. Ta SEULE tâche : déterminer si l'image du produit contient du TEXTE MARKETING INCRUSTÉ (overlay promotionnel ajouté par-dessus la photo en montage).

Réponds UNIQUEMENT en JSON, ce format exact :
{
  "has_marketing_overlay": <true|false>,
  "confidence": <0.0 à 1.0>,
  "reason": "<une phrase courte>"
}

EST du texte marketing incrusté (has_marketing_overlay = true) :
- Slogans / accroches promotionnelles (« MULTI-LEVEL FUN », « BEST SELLER », « NOUVEAU »)
- Prix, rabais, badges (« -50% », « SAVE $20 », « SOLDE »)
- Logos ou filigranes de marque AJOUTÉS par-dessus la photo en post-production
- Flèches, bulles, callouts, listes de caractéristiques superposées à l'image
- Bandeaux ou cartouches de texte ajoutés en montage

N'EST PAS du texte marketing incrusté (has_marketing_overlay = false — texte DIÉGÉTIQUE, qui fait naturellement partie de la scène réelle) :
- Texte imprimé sur le produit lui-même (marque gravée, étiquette, cadran d'horloge, touches de clavier)
- Texte présent naturellement dans le décor (titre d'un livre sur une étagère, enseigne dans la pièce, emballage d'un produit tiers)
- Aucune présence de texte

Règles :
- En cas de doute entre overlay marketing et texte diégétique, considère-le DIÉGÉTIQUE (has_marketing_overlay = false).
- Ne juge PAS la qualité, le fond, ni la mise en scène — UNIQUEMENT la présence de texte marketing incrusté.`;

/** Pick the Anthropic image media_type from a URL's extension. Defaults to JPEG. */
function mediaTypeFor(src: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const path = src.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/** Default longest edge requested from the CDN. See CLASSIFY_PX below. */
export const DEFAULT_CLASSIFY_PX = 1024;

/**
 * For a Shopify CDN URL, request a resized variant to keep the base64 payload small.
 * Restricted to Shopify CDN hosts — the `_WxH` suffix is a Shopify-specific transform, so
 * rewriting an arbitrary CDN URL would 404. Any non-Shopify URL (or one without a file
 * extension) is returned unchanged.
 *
 * The size is the single biggest cost lever: an image costs ≈ (w×h)/750 input tokens, so
 * 512px is ~2× cheaper per call than 1024px (measured: 952 vs 1961 tokens end-to-end).
 */
function resizedUrl(src: string, px: number): string {
  if (!/(^|\.)shopify(cdn)?\.com\//.test(src) && !src.includes("/s/files/")) return src;
  const [path, query] = src.split("?");
  if (!/\.[a-zA-Z]+$/.test(path)) return src;
  const resized = path.replace(/(\.[a-zA-Z]+)$/, `_${px}x${px}$1`);
  return query ? `${resized}?${query}` : resized;
}

async function downloadBase64(src: string, px: number): Promise<string> {
  const res = await fetch(resizedUrl(src, px));
  if (!res.ok) throw new Error(`image download ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

export interface ClassifyOptions {
  /** Longest edge requested from the CDN. Default DEFAULT_CLASSIFY_PX (1024). */
  px?: number;
  /**
   * Charge the call to the uncapped `maintenance` pool instead of `batch`.
   *
   * ⚠️ SCRIPTS ONLY — never pass this from a request path or a cron job. A full pos-1 audit
   * is ~2,500 vision calls, roughly two days of the entire `batch` cap, so running it there
   * would starve imports, blog and social generation. `maintenance` is uncapped but still
   * COUNTED and shown on the usage dashboard — the spend stays visible, it just no longer
   * competes with production's own budget.
   */
  maintenance?: boolean;
}

/**
 * Classify a single product image for pos-1 compliance.
 *
 * Downloads the image, sends it to CLAUDE.MODEL_BATCH with the strict overlay prompt, and
 * returns whether it is a clean primary image. Throws on download / API / parse failure so
 * the caller can distinguish an error from a real "non-compliant" verdict (a failed
 * classification must never be treated as a licence to swap).
 */
export async function classifyProductImage(
  imageUrl: string,
  options: ClassifyOptions = {},
): Promise<ImageClassification> {
  if (!imageUrl || !imageUrl.trim()) throw new Error("classifyProductImage: empty imageUrl");

  const b64 = await downloadBase64(imageUrl, options.px ?? DEFAULT_CLASSIFY_PX);
  const client = getAnthropicClient();

  const request = {
    model: CLAUDE.MODEL_BATCH,
    // 200 truncated the JSON mid-object on verbose verdicts (the model listed every measured
    // dimension it found), which threw as "invalid JSON" and cost the product its audit.
    // Measured on a 1,730-product pass: 2 losses at 200, none at 400.
    max_tokens: 400,
    system: STRICT_OVERLAY_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, source: { type: "base64" as const, media_type: mediaTypeFor(imageUrl), data: b64 } },
          { type: "text" as const, text: "Classifie cette image (position 1)." },
        ],
      },
    ],
  };

  // Always through budgetedCreate — only the POOL changes. Keeping the one API entry point
  // means a maintenance pass is still metered and visible, and the repo-wide guard that
  // forbids a bare client.messages.create() keeps protecting every other caller.
  const message = await budgetedCreate(client, request, undefined, options.maintenance ? "maintenance" : "batch");

  const text = message.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`classifyProductImage: no JSON in Claude reply: ${text.slice(0, 120)}`);

  let parsed: { has_marketing_overlay?: unknown; reason?: unknown; confidence?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`classifyProductImage: invalid JSON: ${jsonMatch[0].slice(0, 120)}`);
  }
  if (typeof parsed.has_marketing_overlay !== "boolean") {
    throw new Error("classifyProductImage: missing has_marketing_overlay boolean");
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 200)
    : (parsed.has_marketing_overlay ? "texte marketing incrusté détecté" : "image propre");

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : undefined;

  return { compliant: !parsed.has_marketing_overlay, reason, confidence };
}
