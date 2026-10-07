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
 *   shopify_guide                →  GuideQueuePayload
 *     { guidePageId, blogId, articleId, shopifyCollectionId, shopifyHandle } — the article
 *     already exists as a Shopify draft (created at generation time); this just flips it
 *     live via publishBlogArticle, records the guide_pages row as published, and (best-
 *     effort) sets the collection's `custom.guide_url` metafield so the storefront can show
 *     a "Guide d'achat" link. See guide-scheduler.ts (the producer).
 *
 * A malformed payload throws (→ markFailed), so a bad producer never silently no-ops.
 */
import { type FacebookBrand } from "./facebook-client";
import { publishSocialPayload, type SocialPayload } from "./social-publisher";
import { createBlogArticle, publishBlogArticle, getBlogArticleBody } from "./shopify-blog";
import { stripGuideDraftBanner, hasGuideDraftBanner } from "./guide-draft-banner";
import { setCollectionMetafield, getShopifyProductTitle } from "./shopify-client";
import { stripSupplierBrands } from "./catalog-guard";
import { getAnthropicClient } from "./content-generator";
import { llmModel } from "@/lib/llm-models";
import { budgetedCreate } from "@/lib/llm-budget";
import { cleanSocialCaption } from "./strip-markdown";
import { CLAUDE, BLOG } from "./config";

const { GUIDE_URL_METAFIELD } = BLOG;
import {
  getNextPending,
  claimQueueItem,
  reclaimStrandedPublishing,
  markPublished,
  markFailed,
  markGuidePagePublished,
  getProduct,
  flagSequentialAdForRerender,
  createNotification,
  recordQueuePostIds,
  type PublicationQueueItem,
} from "./database";
import { checkSequentialAdPrice } from "./sequential-ad-price";
import { addUtm, tagCaptionLinks } from "./utm";

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

export interface GuideQueuePayload {
  guidePageId: number;
  blogId: number;
  articleId: string;
  shopifyCollectionId: string;
  shopifyHandle: string;
}

/** Validate + narrow a raw payload for a pSEO guide deferred publish. */
export function parseGuidePayload(raw: unknown): GuideQueuePayload {
  if (!raw || typeof raw !== "object") throw new Error("payload must be a JSON object");
  const o = raw as Record<string, unknown>;
  const guidePageId = Number(o.guidePageId);
  if (!Number.isInteger(guidePageId) || guidePageId <= 0) {
    throw new Error("payload.guidePageId must be a positive integer");
  }
  const blogId = Number(o.blogId);
  if (!Number.isInteger(blogId) || blogId <= 0) {
    throw new Error("payload.blogId must be a positive integer");
  }
  if (typeof o.articleId !== "string" || o.articleId.trim() === "") {
    throw new Error("payload.articleId is required");
  }
  if (typeof o.shopifyCollectionId !== "string" || o.shopifyCollectionId.trim() === "") {
    throw new Error("payload.shopifyCollectionId is required");
  }
  if (typeof o.shopifyHandle !== "string" || o.shopifyHandle.trim() === "") {
    throw new Error("payload.shopifyHandle is required");
  }
  return {
    guidePageId,
    blogId,
    articleId: o.articleId,
    shopifyCollectionId: o.shopifyCollectionId,
    shopifyHandle: o.shopifyHandle,
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
  /** The Facebook post (a Reel's video id) when one was created — what its insights are read from. */
  fbPostId?: string;
  /** The Instagram media id when one was created. */
  igPostId?: string;
  /** Set when one channel of a 'both' post failed while the other succeeded. */
  partialError?: string;
}

/** Per-platform last touch on a payload just before it goes out (UTM tagging of a Reel's links). */
type Decorate = (p: SocialQueuePayload, platform: "facebook" | "instagram") => SocialQueuePayload;

/**
 * UTM tags for a Reel's storefront links: which platform sent the click, what kind of video it was, which video. Applied at
 * publish time so videos approved long ago are tagged too and the stored caption stays clean. `ameubloVideoId` (Studio videos)
 * names the video; batch videos fall back to their queue row.
 */
function reelUtm(item: PublicationQueueItem): Decorate {
  const meta = item.metadata ?? {};
  const campaign = typeof meta.style === "string" && meta.style ? meta.style : item.contentType;
  const content = typeof meta.ameubloVideoId === "number" ? `v${meta.ameubloVideoId}` : `q${item.id}`;
  return (p, platform) => {
    const utm = { source: platform, medium: "reel", campaign, content };
    return { ...p, caption: tagCaptionLinks(p.caption, utm), link: p.link ? addUtm(p.link, utm) : p.link };
  };
}

/**
 * UTM tags for a photo post's storefront links: which platform sent the click, what kind of post it was (the La semaine Ameublo
 * format, else "social"), which post (its queue row). Same publish-time tagging as the Reels, with medium=photo.
 */
function socialUtm(item: PublicationQueueItem): Decorate {
  const meta = item.metadata ?? {};
  const campaign = typeof meta.format === "string" && meta.format ? meta.format : "social";
  return (p, platform) => {
    const utm = { source: platform, medium: "photo", campaign, content: `q${item.id}` };
    return { ...p, caption: tagCaptionLinks(p.caption, utm), link: p.link ? addUtm(p.link, utm) : p.link };
  };
}

/** Publish on ONE platform, recording which post it became. */
async function publishOn(platform: "facebook" | "instagram", p: SocialQueuePayload, decorate?: Decorate): Promise<PublishItemResult> {
  const { postId } = await publishSocialPayload(platform, toSocialPayload(decorate ? decorate(p, platform) : p));
  return platform === "facebook" ? { postId, fbPostId: postId } : { postId, igPostId: postId };
}

/**
 * Publish to Facebook and Instagram. Succeeds if at least one channel publishes (mirrors
 * publishDraftToChannels' firstOk behavior) so a retry can't double-post the channel that
 * already went out. Throws only when BOTH fail. A partial failure is surfaced via
 * `partialError` (logged by the caller) — the item is still marked published.
 */
async function publishToBoth(p: SocialQueuePayload, decorate?: Decorate): Promise<PublishItemResult> {
  let fbId: string | undefined;
  let igId: string | undefined;
  const errors: string[] = [];
  try {
    fbId = (await publishSocialPayload("facebook", toSocialPayload(decorate ? decorate(p, "facebook") : p))).postId;
  } catch (err) {
    errors.push(`facebook: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    igId = (await publishSocialPayload("instagram", toSocialPayload(decorate ? decorate(p, "instagram") : p))).postId;
  } catch (err) {
    errors.push(`instagram: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!fbId && !igId) throw new Error(errors.join(" | "));
  return {
    postId: (fbId ?? igId)!,
    fbPostId: fbId,
    igPostId: igId,
    partialError: errors.length > 0 ? errors.join(" | ") : undefined,
  };
}

const LANG_LABEL = { fr: "français", en: "anglais" } as const;

/** What each batch video shows — the caption writer's angle. */
export const BATCH_VIDEO_ANGLE: Record<string, string> = {
  assembly: "vidéo qui montre le montage du produit, étape par étape, fait soi-même à la maison",
  demand_gen_ext: "courte vidéo qui montre le produit en situation réelle",
};

/**
 * Turn a content-batches queue payload ({sku, productName, blobUrl}) into a publishable Reel:
 * the REAL French product title from Shopify (productName is sometimes a label like "on monte
 * le meuble à chat"), a link to the product page, and a direct-response caption. Never throws
 * over the caption — it falls back to the title — only over a payload with no video.
 */
export async function batchVideoToSocialPayload(contentType: string, raw: unknown): Promise<SocialQueuePayload> {
  if (!raw || typeof raw !== "object") throw new Error("payload must be a JSON object");
  const o = raw as Record<string, unknown>;
  const blobUrl = optString(o.blobUrl) ?? optString(o.reelsVideoUrl);
  if (!blobUrl) throw new Error("payload.blobUrl is required");
  const sku = optString(o.sku);
  const fallbackName = optString(o.productName) ?? "";
  let title = fallbackName;
  let link: string | undefined;
  if (sku) {
    try {
      const product = await getProduct(sku);
      if (product?.shopify_product_id) title = await getShopifyProductTitle(product.shopify_product_id, fallbackName);
      if (product?.shopify_handle) link = `https://ameublodirect.ca/products/${product.shopify_handle}`;
    } catch (err) {
      console.warn(`[publisher] ${contentType} ${sku}: product lookup failed, using the stored name: ${err instanceof Error ? err.message : err}`);
    }
  }
  const angle = BATCH_VIDEO_ANGLE[contentType] ?? "vidéo du produit";
  const generated = optString(o.caption) ? null : await generateReelCaption(`${title} — ${angle}`, "fr");
  const caption = optString(o.caption) ?? generated ?? `${title} — livraison gratuite au Canada.${link ? ` 👉 ${link}` : ""}`;
  // The generated caption tells people "le lien est sous la vidéo", but a Reel has no link field: `link` is only used for
  // text-only Facebook posts, so these Reels went out with NO link at all (found 2026-10-06). Put it in the caption itself.
  const withLink = link && !caption.includes(link) ? `${caption}\n\n👉 ${link}` : caption;
  return { caption: stripSupplierBrands(withLink), brand: "ameublo", reelsVideoUrl: blobUrl, link };
}

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
  // Direct-response style "à la Alex Hormozi" (Mat, 2026-10-01): a scroll-stopping first line
  // built on a concrete benefit or the problem it solves, then value, then a clear call to
  // action. Truthful only: no price (it changes), no fake urgency/scarcity, no supplier name.
  const prompt =
    `Écris le texte d'une vidéo Facebook/Instagram en ${LANG_LABEL[language]}, style direct-response à la Alex Hormozi, ` +
    `pour ce produit : ${productText}.\n` +
    `Structure : 1) une accroche-choc en première ligne (le problème réglé ou le bénéfice concret, jamais vague) ; ` +
    `2) une phrase de valeur concrète ; 3) un appel à l'action clair (voir le produit, magasiner). ` +
    `1 ou 2 émojis maximum. Max 220 caractères. ${language === "fr" ? "Vouvoiement." : ""}\n` +
    `Vérité absolue : n'affirme AUCUNE caractéristique, durée, quantité ou résultat qui n'est pas écrit dans le nom du produit ` +
    `(jamais "en 30 minutes", "sans outil", "pendant des heures", "absorbe les odeurs", "montage garanti"). ` +
    `L'accroche peut nommer un besoin courant, sans exagérer. ` +
    `Ton direct mais poli et chaleureux : jamais vulgaire, jamais dégoûtant, jamais culpabilisant. ` +
    `Pas de "lien en bio" (le lien est sous la vidéo).\n` +
    `Interdit : tout prix ou pourcentage, fausse urgence ou fausse rareté ("dernière chance", "stock limité"), ` +
    `superlatifs invérifiables ("le meilleur"), nom de fournisseur ou de marque fabricante, hashtags. ` +
    `La livraison gratuite au Canada est vraie : tu peux la mentionner. ` +
    `Réponds uniquement avec le texte, sans guillemets.`;
  try {
    const message = await budgetedCreate(getAnthropicClient(), {
      model: llmModel("strong"),
      max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    if (!block || block.type !== "text") return null;
    // Same cleanup as the draft paths: strip surrounding quotes, Markdown, and a
    // leading platform-label line ("Post Facebook 🌿") — this reel caption is
    // published unreviewed, so it must not ship a label prefix.
    const text = stripSupplierBrands(cleanSocialCaption(block.text.trim().replace(/^["']+|["']+$/g, "")));
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
 * on the payload and post garbage. Fail loud → markFailed instead. Each dedicated
 * (platform, content_type) pair below is checked both ways (a platform-specific row must
 * carry its matching content_type, and vice versa).
 */
const DEDICATED_PLATFORM_CONTENT_TYPE = {
  shopify_blog: "blog",
  shopify_guide: "guide",
} as const;

function assertContentPlatformPairing(item: PublicationQueueItem): void {
  for (const [platform, contentType] of Object.entries(DEDICATED_PLATFORM_CONTENT_TYPE)) {
    const isThisPlatform = item.platform === platform;
    const isThisContentType = item.contentType === contentType;
    if (isThisPlatform !== isThisContentType) {
      throw new Error(
        `content_type '${item.contentType}' does not match platform '${item.platform}'`,
      );
    }
  }
}

/**
 * Publish one queue item according to its platform. Returns the published post id.
 * Throws on an invalid payload or a publish failure — the caller maps that to markFailed.
 */
/** A sequential ad whose burned price changed since the render — never publish it. */
export class SequentialAdPriceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequentialAdPriceChangedError";
  }
}

export async function publishQueueItem(item: PublicationQueueItem): Promise<PublishItemResult> {
  assertContentPlatformPairing(item);

  // Last line of the price guard (sequential-ad-price.ts): the price may have moved between
  // approval and the slot. A wrong price in the frame is worse than a late post.
  if (item.contentType === "sequential_ad") {
    const price = await checkSequentialAdPrice(item);
    if (!price.ok) throw new SequentialAdPriceChangedError(price.reason!);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(item.payload);
  } catch {
    throw new Error("payload is not valid JSON");
  }

  // Batch video formats (content-batches pipeline) are queued as {sku, productName, blobUrl}
  // — no caption, no brand — so they used to hit parseSocialPayload below and fail with
  // "payload.caption is required": 0 ever published, every scheduled one failed (found
  // 2026-10-01). Build a real Reel payload from the product instead.
  if (item.contentType in BATCH_VIDEO_ANGLE) {
    const social = await batchVideoToSocialPayload(item.contentType, raw);
    const decorate = reelUtm(item);
    switch (item.platform) {
      case "facebook":
        return publishOn("facebook", social, decorate);
      case "instagram":
        return publishOn("instagram", social, decorate);
      case "both":
        return publishToBoth(social, decorate);
      default:
        throw new Error(`Unsupported platform for ${item.contentType}: ${item.platform}`);
    }
  }

  // Reels (content_type='video' or 'sequential_ad' with a reelsVideoUrl): regenerate the
  // caption as fresh clickbait at publish time. Language follows the brand (furnish → EN,
  // ameublo → FR). If generation fails, keep the stored caption — never block the publish.
  if (item.contentType === "video" || item.contentType === "sequential_ad") {
    const social = parseSocialPayload(raw);
    if (social.reelsVideoUrl) {
      const language: "fr" | "en" = social.brand === "furnish" ? "en" : "fr";
      // Studio Ameublo videos carry a deterministic, operator-editable caption: keep it as-is.
      const clickbait = item.metadata?.keepCaption === true ? null : await generateReelCaption(social.caption, language);
      const finalPayload: SocialQueuePayload = clickbait ? { ...social, caption: clickbait } : social;
      const decorate = reelUtm(item);
      switch (item.platform) {
        case "facebook":
          return publishOn("facebook", finalPayload, decorate);
        case "instagram":
          return publishOn("instagram", finalPayload, decorate);
        case "both":
          return publishToBoth(finalPayload, decorate);
        default:
          throw new Error(`Unsupported platform for video content_type: ${item.platform}`);
      }
    }
  }

  // Photo / album posts ('social'): tag the storefront links so Umami can tell which post brought a visit, and use publishOn so
  // the post id is recorded even for a single-platform post (the bare call below returns no id to measure). Other content types
  // (blog, guide…) keep their own handling.
  const photoDecorate = item.contentType === "social" ? socialUtm(item) : undefined;

  switch (item.platform) {
    case "facebook":
      return photoDecorate ? publishOn("facebook", parseSocialPayload(raw), photoDecorate) : { postId: (await publishSocialPayload("facebook", toSocialPayload(parseSocialPayload(raw)))).postId };
    case "instagram":
      return photoDecorate ? publishOn("instagram", parseSocialPayload(raw), photoDecorate) : { postId: (await publishSocialPayload("instagram", toSocialPayload(parseSocialPayload(raw)))).postId };
    case "both":
      return publishToBoth(parseSocialPayload(raw), photoDecorate);
    case "shopify_blog":
      return { postId: (await createBlogArticle(parseBlogPayload(raw))).articleId };
    case "shopify_guide": {
      const payload = parseGuidePayload(raw);
      // The draft carries a "BROUILLON — Ne pas publier" review banner. Read the CURRENT
      // Shopify body (it may have been edited in admin since generation), drop the banner, and
      // write it in the same PUT as the publish flip. Fail closed: if a banner is still there
      // after stripping (Shopify re-serialized it into a shape we don't recognize), throw
      // (→ markFailed) rather than put "Ne pas publier" on the live storefront.
      const currentBody = await getBlogArticleBody(payload.blogId, payload.articleId);
      const publicBody = stripGuideDraftBanner(currentBody);
      if (!publicBody.trim()) throw new Error(`guide ${payload.guidePageId}: Shopify article body is empty`);
      if (hasGuideDraftBanner(publicBody)) {
        throw new Error(`guide ${payload.guidePageId}: draft banner could not be removed — not publishing`);
      }
      await publishBlogArticle(payload.blogId, payload.articleId, publicBody);
      await markGuidePagePublished(payload.guidePageId);
      // Best-effort: the "Guide d'achat" collection link (Task C) is a discoverability
      // nicety, not the primary effect. The article is already live at this point — a
      // metafield write failure must never make this publish look failed (→ markFailed
      // would leave guide_pages inconsistent with the real, already-live Shopify article).
      try {
        await setCollectionMetafield(
          payload.shopifyCollectionId,
          GUIDE_URL_METAFIELD.namespace,
          GUIDE_URL_METAFIELD.key,
          GUIDE_URL_METAFIELD.type,
          `/blogs/guides/${payload.shopifyHandle}`,
        );
      } catch (err) {
        console.error(
          `[publisher] guide ${payload.guidePageId} published, but setting the collection "Guide d'achat" link failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      return { postId: payload.articleId };
    }
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
  /** Rows the reaper returned from a stranded 'publishing' state to 'pending' this run. */
  reclaimed: number;
  outcomes: PublishOutcome[];
}

const DEFAULT_LIMIT = 5;
const DEFAULT_RATE_LIMIT_MS = 2_000;
// Stop claiming new items once this much wall-clock has elapsed. Kept under the route's
// maxDuration (300s) so an in-flight publish (an IG reel transcode can poll ~120s) can
// finish and the function can return cleanly. A claim we can't finish before Vercel
// SIGKILLs the function would strand the item in 'publishing' — getNextPending only
// re-selects 'pending'. Deferring instead leaves the item 'pending' for the next hourly run.
// A row stranded despite that is now recovered automatically by the reaper below, so the
// manual "UPDATE publication_queue SET status='pending'" recovery is no longer needed.
const DEFAULT_BUDGET_MS = 240_000;

/**
 * How long a row may sit in 'publishing' before the reaper declares it dead.
 *
 * MUST stay above PUBLISHER_MAX_DURATION_SECONDS (300s). Vercel kills the function at 300s,
 * so a row claimed longer ago than that provably is not being published any more. The extra
 * 60s covers the gap between the claim and the kill, plus clock skew between instances.
 * Drop below 300 and the reaper can hand a LIVE publish back to the next run — the same post
 * twice on Facebook. reclaimStrandedPublishing throws rather than accept a smaller window.
 */
const DEFAULT_STALE_CLAIM_SECONDS = 360;

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
  /** Seconds a row may sit in 'publishing' before the reaper retries it. Must be >= 300. */
  staleClaimSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Promise<DrainResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const staleClaimSeconds = opts.staleClaimSeconds ?? DEFAULT_STALE_CLAIM_SECONDS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const start = now();

  // Reap first, so anything stranded by a previous run is 'pending' again before we select.
  // Best-effort: a reaper failure must not stop the drain — the queue still moves, the
  // stranded rows just wait for the next hourly run.
  let reclaimed = 0;
  try {
    reclaimed = await reclaimStrandedPublishing(staleClaimSeconds);
    if (reclaimed > 0) {
      console.warn(
        `[publisher] reaped ${reclaimed} row(s) stranded in 'publishing' for more than ${staleClaimSeconds}s — returned to 'pending'`,
      );
    }
  } catch (err) {
    console.error("[publisher] reaper failed (draining anyway):", err instanceof Error ? err.message : err);
  }

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
      // Remember which posts this became, so their insights can be read later. Best-effort: the post is already live and
      // marked published — a failure here must never turn that into a failed item (a retry would double-post).
      try {
        await recordQueuePostIds(item.id, { fb: result.fbPostId, ig: result.igPostId });
      } catch (err) {
        console.warn(`[publisher] item ${item.id}: could not record the post ids: ${err instanceof Error ? err.message : err}`);
      }
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
      if (err instanceof SequentialAdPriceChangedError) {
        // Back to draft, flagged for a re-render — not a failure, and its slot is freed.
        await flagSequentialAdForRerender(item.id, msg);
        await createNotification("warning", "Pub séquentielle remise en brouillon", `#${item.id} : ${msg}`).catch(() => undefined);
        console.warn(`[publisher] item ${item.id} held for re-render: ${msg}`);
        outcomes.push({ id: item.id, platform: item.platform, status: "skipped", error: msg });
        continue;
      }
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
    reclaimed,
    outcomes,
  };
}
