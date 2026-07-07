/**
 * Publication-queue consumer: turns a `publication_queue` row into a real published
 * post and drives the pending → publishing → published/failed lifecycle.
 *
 * Producers store the content as a JSON-stringified `payload` on the queue row; the
 * cron drains due rows and dispatches by `platform`. The payload contract this consumer
 * expects:
 *
 *   facebook | instagram | both  →  SocialQueuePayload
 *     { caption, brand: "ameublo"|"furnish", imageUrl?, imageUrls?, videoUrl?,
 *       reelsVideoUrl?, link? }
 *
 *   shopify_blog                 →  BlogQueuePayload
 *     { title, bodyHtml, lang: "fr"|"en", featuredImage?, summaryHtml?, tags?,
 *       author?, metaDescription? }
 *
 * A malformed payload throws (→ markFailed), so a bad producer never silently no-ops.
 */
import { type FacebookBrand } from "./facebook-client";
import { publishSocialPayload, type SocialPayload } from "./social-publisher";
import { createBlogArticle } from "./shopify-blog";
import { getAnthropicClient } from "./content-generator";
import { cleanSocialCaption } from "./strip-markdown";
import { CLAUDE } from "./config";
import {
  getNextPending,
  claimQueueItem,
  markPublished,
  markFailed,
  type PublicationQueueItem,
} from "./database";

export interface SocialQueuePayload {
  caption: string;
  brand: FacebookBrand; // === InstagramBrand ("ameublo" | "furnish")
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  reelsVideoUrl?: string;
  link?: string;
}

export interface BlogQueuePayload {
  title: string;
  bodyHtml: string;
  lang: "fr" | "en";
  featuredImage?: { src: string; alt?: string };
  summaryHtml?: string;
  tags?: string | string[];
  author?: string;
  metaDescription?: string;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** Validate + narrow a raw payload for a social platform. Throws on missing required fields. */
export function parseSocialPayload(raw: unknown): SocialQueuePayload {
  if (!raw || typeof raw !== "object") throw new Error("payload must be a JSON object");
  const o = raw as Record<string, unknown>;
  const caption = o.caption;
  if (typeof caption !== "string" || caption.trim() === "") {
    throw new Error("payload.caption is required");
  }
  if (o.brand !== "ameublo" && o.brand !== "furnish") {
    throw new Error("payload.brand must be 'ameublo' or 'furnish'");
  }
  const imageUrls = Array.isArray(o.imageUrls)
    ? o.imageUrls.filter((u): u is string => typeof u === "string" && u.trim() !== "")
    : undefined;
  return {
    caption,
    brand: o.brand,
    imageUrl: optString(o.imageUrl),
    imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
    videoUrl: optString(o.videoUrl),
    reelsVideoUrl: optString(o.reelsVideoUrl),
    link: optString(o.link),
  };
}

/** Validate + narrow a raw payload for a Shopify blog article. Throws on missing required fields. */
export function parseBlogPayload(raw: unknown): BlogQueuePayload {
  if (!raw || typeof raw !== "object") throw new Error("payload must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== "string" || o.title.trim() === "") {
    throw new Error("payload.title is required");
  }
  if (typeof o.bodyHtml !== "string" || o.bodyHtml.trim() === "") {
    throw new Error("payload.bodyHtml is required");
  }
  if (o.lang !== "fr" && o.lang !== "en") {
    throw new Error("payload.lang must be 'fr' or 'en'");
  }
  const fi = o.featuredImage;
  let featuredImage: BlogQueuePayload["featuredImage"];
  if (fi && typeof fi === "object" && typeof (fi as Record<string, unknown>).src === "string") {
    const f = fi as Record<string, unknown>;
    featuredImage = { src: f.src as string, alt: optString(f.alt) };
  }
  const tags = Array.isArray(o.tags)
    ? (o.tags.filter((t) => typeof t === "string") as string[])
    : optString(o.tags);
  return {
    title: o.title,
    bodyHtml: o.bodyHtml,
    lang: o.lang,
    featuredImage,
    summaryHtml: optString(o.summaryHtml),
    tags,
    author: optString(o.author),
    metaDescription: optString(o.metaDescription),
  };
}

/**
 * Normalize a queue payload (which also allows a singular `imageUrl`) into the shared
 * SocialPayload consumed by publishSocialPayload — the one place FB/IG media routing lives.
 */
function toSocialPayload(p: SocialQueuePayload): SocialPayload {
  return {
    caption: p.caption,
    brand: p.brand,
    imageUrls: p.imageUrls ?? (p.imageUrl ? [p.imageUrl] : undefined),
    videoUrl: p.videoUrl,
    reelsVideoUrl: p.reelsVideoUrl,
    link: p.link,
  };
}

export interface PublishItemResult {
  postId: string;
  /** Set when one channel of a 'both' post failed while the other succeeded. */
  partialError?: string;
}

/**
 * Publish to Facebook and Instagram. Succeeds if at least one channel publishes (mirrors
 * publishDraftToChannels' firstOk behavior) so a retry can't double-post the channel that
 * already went out. Throws only when BOTH fail. A partial failure is surfaced via
 * `partialError` (logged by the caller) — the item is still marked published.
 */
async function publishToBoth(p: SocialQueuePayload): Promise<PublishItemResult> {
  const sp = toSocialPayload(p);
  let fbId: string | undefined;
  let igId: string | undefined;
  const errors: string[] = [];
  try {
    fbId = (await publishSocialPayload("facebook", sp)).postId;
  } catch (err) {
    errors.push(`facebook: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    igId = (await publishSocialPayload("instagram", sp)).postId;
  } catch (err) {
    errors.push(`instagram: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!fbId && !igId) throw new Error(errors.join(" | "));
  return {
    postId: (fbId ?? igId)!,
    partialError: errors.length > 0 ? errors.join(" | ") : undefined,
  };
}

const LANG_LABEL = { fr: "français", en: "anglais" } as const;

/**
 * Generate a short clickbait caption for a Reel at publish time, so the posted copy is
 * punchier than the stored product title. Returns the generated text, or `null` on any
 * failure (empty/refused/non-text response, API error) — the caller then keeps the original
 * caption. Caption generation must NEVER block a publish, so every failure path is non-fatal.
 */
export async function generateReelCaption(
  productText: string,
  language: "fr" | "en",
): Promise<string | null> {
  const prompt =
    `Génère un texte Facebook/Instagram clickbait de 2-3 phrases en ${LANG_LABEL[language]} ` +
    `pour ce produit : ${productText}. Accrocheur, émoji, appel à l'action. Max 150 caractères. ` +
    `Pas de hashtags — ils seront ajoutés séparément. Réponds uniquement avec le texte, sans guillemets.`;
  try {
    const message = await getAnthropicClient().messages.create({
      model: CLAUDE.MODEL,
      max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    if (!block || block.type !== "text") return null;
    // Same cleanup as the draft paths: strip surrounding quotes, Markdown, and a
    // leading platform-label line ("Post Facebook 🌿") — this reel caption is
    // published unreviewed, so it must not ship a label prefix.
    const text = cleanSocialCaption(block.text.trim().replace(/^["']+|["']+$/g, ""));
    return text || null;
  } catch (err) {
    console.warn(
      `[publisher] Reel clickbait generation failed, keeping original caption: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Guard that content_type agrees with platform before dispatch. The DB CHECK constraints
 * allow any combination, and dispatch keys only on platform — so a row with
 * content_type='blog' but platform='facebook' (or vice versa) would run the wrong parser
 * on the payload and post garbage. Fail loud → markFailed instead.
 */
function assertContentPlatformPairing(item: PublicationQueueItem): void {
  const isBlogPlatform = item.platform === "shopify_blog";
  const isBlogContent = item.contentType === "blog";
  if (isBlogPlatform !== isBlogContent) {
    throw new Error(
      `content_type '${item.contentType}' does not match platform '${item.platform}'`,
    );
  }
}

/**
 * Publish one queue item according to its platform. Returns the published post id.
 * Throws on an invalid payload or a publish failure — the caller maps that to markFailed.
 */
export async function publishQueueItem(item: PublicationQueueItem): Promise<PublishItemResult> {
  assertContentPlatformPairing(item);

  let raw: unknown;
  try {
    raw = JSON.parse(item.payload);
  } catch {
    throw new Error("payload is not valid JSON");
  }

  // Reels (content_type='video' with a reelsVideoUrl): regenerate the caption as fresh
  // clickbait at publish time. Language follows the brand (furnish → EN, ameublo → FR).
  // If generation fails, keep the stored caption — never block the publish.
  if (item.contentType === "video") {
    const social = parseSocialPayload(raw);
    if (social.reelsVideoUrl) {
      const language: "fr" | "en" = social.brand === "furnish" ? "en" : "fr";
      const clickbait = await generateReelCaption(social.caption, language);
      const finalPayload: SocialQueuePayload = clickbait ? { ...social, caption: clickbait } : social;
      switch (item.platform) {
        case "facebook":
          return { postId: (await publishSocialPayload("facebook", toSocialPayload(finalPayload))).postId };
        case "instagram":
          return { postId: (await publishSocialPayload("instagram", toSocialPayload(finalPayload))).postId };
        case "both":
          return publishToBoth(finalPayload);
        default:
          throw new Error(`Unsupported platform for video content_type: ${item.platform}`);
      }
    }
  }

  switch (item.platform) {
    case "facebook":
      return { postId: (await publishSocialPayload("facebook", toSocialPayload(parseSocialPayload(raw)))).postId };
    case "instagram":
      return { postId: (await publishSocialPayload("instagram", toSocialPayload(parseSocialPayload(raw)))).postId };
    case "both":
      return publishToBoth(parseSocialPayload(raw));
    case "shopify_blog":
      return { postId: (await createBlogArticle(parseBlogPayload(raw))).articleId };
    default:
      throw new Error(`Unsupported platform: ${item.platform}`);
  }
}

export interface PublishOutcome {
  id: number;
  platform: string;
  status: "published" | "failed" | "skipped";
  postId?: string;
  error?: string;
  partialError?: string;
}

export interface DrainResult {
  processed: number;
  published: number;
  failed: number;
  skipped: number;
  /** Items left 'pending' because the time budget ran out before claiming them. */
  deferred: number;
  outcomes: PublishOutcome[];
}

const DEFAULT_LIMIT = 5;
const DEFAULT_RATE_LIMIT_MS = 2_000;
// Stop claiming new items once this much wall-clock has elapsed. Kept under the route's
// maxDuration (300s) so an in-flight publish (an IG reel transcode can poll ~120s) can
// finish and the function can return cleanly. A claim we can't finish before Vercel
// SIGKILLs the function would strand the item in 'publishing' — getNextPending only
// re-selects 'pending', and there is no reaper today (same gap as claimFacebookDraft).
// Deferring instead leaves the item 'pending' for the next hourly run. Recover a stranded
// row manually with:  UPDATE publication_queue SET status='pending' WHERE status='publishing';
const DEFAULT_BUDGET_MS = 240_000;

/**
 * Drain up to `limit` due pending items. For each: atomically claim it (skip if another
 * cron instance won the claim — prevents double-publish), publish, then mark
 * published/failed. Waits `rateLimitMs` between publish attempts so we don't burst the
 * Graph APIs, and stops claiming new items past `budgetMs` so a long run doesn't get
 * SIGKILLed mid-publish (which would strand a claimed item — see note above).
 * `sleep` and `now` are injectable so tests don't actually wait.
 */
export async function drainPublisherQueue(opts: {
  limit?: number;
  rateLimitMs?: number;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Promise<DrainResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const start = now();

  const pending = await getNextPending(limit);
  const outcomes: PublishOutcome[] = [];
  let attempts = 0;
  let deferred = 0;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];

    // Don't start work we might not finish before maxDuration. Leaving the item 'pending'
    // is safe (next run retries it); claiming-then-getting-killed strands it.
    if (now() - start >= budgetMs) {
      deferred = pending.length - i;
      console.warn(`[publisher] time budget reached — deferring ${deferred} item(s) to the next run`);
      break;
    }

    const claimed = await claimQueueItem(item.id);
    if (!claimed) {
      // Another cron instance already took it — don't touch it.
      outcomes.push({ id: item.id, platform: item.platform, status: "skipped" });
      continue;
    }

    // Rate limit BETWEEN actual publish attempts (not before the first, not for skips).
    if (attempts > 0) await sleep(rateLimitMs);
    attempts++;

    try {
      const result = await publishQueueItem(item);
      await markPublished(item.id);
      if (result.partialError) {
        console.warn(`[publisher] item ${item.id} (${item.platform}) published with partial failure: ${result.partialError}`);
      }
      outcomes.push({
        id: item.id,
        platform: item.platform,
        status: "published",
        postId: result.postId,
        partialError: result.partialError,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(item.id, msg);
      console.error(`[publisher] item ${item.id} (${item.platform}) failed: ${msg}`);
      outcomes.push({ id: item.id, platform: item.platform, status: "failed", error: msg });
    }
  }

  return {
    processed: outcomes.length,
    published: outcomes.filter((o) => o.status === "published").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    deferred,
    outcomes,
  };
}
