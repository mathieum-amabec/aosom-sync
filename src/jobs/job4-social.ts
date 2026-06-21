/**
 * Job 4 — Social Media Draft Generator (bilingual multi-channel)
 *
 * 3 triggers:
 * - new_product: called after Job 3 imports a product
 * - price_drop: called by Job 1 when price drops >= threshold
 * - stock_highlight: daily cron picks a random eligible product
 *
 * Each draft now stores BOTH FR and EN captions so one draft can publish to
 * all channels (Facebook Ameublo FR, Facebook Furnish EN, Instagram Ameublo FR,
 * future Instagram Furnish EN).
 */
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/content-generator";
import { stripMarkdown } from "@/lib/strip-markdown";
import { composeImage } from "@/lib/image-composer";
import { env, CLAUDE, SYNC, CHANNELS, getPublicAppUrl, type ChannelKey } from "@/lib/config";
import {
  getAllSettings,
  getProduct,
  createFacebookDraft,
  getEligibleHighlightProduct,
  markProductPosted,
  createNotification,
  getAutopostCountToday,
  incrementAutopostCountToday,
} from "@/lib/database";
import { selectHook, buildHookedPrompt, buildHookedPromptEn } from "@/lib/hook-selector";
import { publishDraftToChannels } from "@/lib/social-publisher";

// Job 4 generates STATIC posts only (branded images). Video generation has been
// decoupled out of this job — the new FFmpeg-based slideshow pipeline owns video
// rendering and populates the draft's video_url separately. See
// src/lib/video-engines/ and src/lib/video-brand-tokens.ts.

const ANTHROPIC_CALL_TIMEOUT_MS = 45_000;
const ANTHROPIC_RETRY_DELAY_MS = 5_000;

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[JOB4][${ts}] ${msg}${suffix}`);
}

function logWarn(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  console.warn(`[JOB4][${ts}] WARN ${msg}${suffix}`);
}

function logError(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  console.error(`[JOB4][${ts}] ERROR ${msg}${suffix}`);
}

function getClient() {
  return getAnthropicClient();
}

function getImageSettings(settings: Record<string, string>): {
  accentColor: string;
  textColor: string;
  storeName: string;
  bannerOpacity: number;
} {
  return {
    accentColor: settings.social_accent_color || "#2563eb",
    textColor: settings.social_text_color || "#ffffff",
    storeName: settings.social_store_display_name || env.storeName,
    bannerOpacity: parseInt(settings.social_banner_opacity || "75", 10),
  };
}

function interpolatePrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

async function generatePostText(prompt: string): Promise<string> {
  const client = getClient();
  const t0 = Date.now();
  log("anthropic call started", { prompt_tokens: Math.ceil(prompt.length / 4) });
  const message = await client.messages.create(
    {
      model: CLAUDE.MODEL,
      max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: AbortSignal.timeout(ANTHROPIC_CALL_TIMEOUT_MS) },
  );
  log("anthropic call completed", { duration_ms: Date.now() - t0 });
  // Strip any Markdown the model emitted — Facebook renders **, #, --- literally.
  return message.content[0]?.type === "text" ? stripMarkdown(message.content[0].text) : "";
}

/** Generate FR and EN captions in parallel, with one retry on Anthropic timeout. */
async function generateBilingual(
  settings: Record<string, string>,
  triggerType: "new_product" | "price_drop" | "highlight",
  vars: Record<string, string>,
  productType?: string | null
): Promise<{ fr: string; en: string; hookId: number | null }> {
  const frKey = `prompt_${triggerType}_fr`;
  const enKey = `prompt_${triggerType}_en`;
  const frTpl = settings[frKey] || "Rédige un post Facebook pour: {product_name}";
  const enTpl = settings[enKey] || "Write a Facebook post for: {product_name}";

  const frVars = { ...vars, hashtags: settings.social_hashtags_fr || "" };
  const enVars = { ...vars, hashtags: settings.social_hashtags_en || "" };

  const basePromptFr = interpolatePrompt(frTpl, frVars);
  const basePromptEn = interpolatePrompt(enTpl, enVars);

  // Select a hook for this draft (no draft_id yet — recorded once draft is created)
  let hookId: number | null = null;
  let frPrompt = basePromptFr;
  let enPrompt = basePromptEn;
  try {
    const hookFr = await selectHook("FR", productType, null);
    const hookEn = await selectHook("EN", productType, null);
    frPrompt = buildHookedPrompt(basePromptFr, hookFr);
    enPrompt = buildHookedPromptEn(basePromptEn, hookEn);
    hookId = hookFr.hookId;
  } catch (hookErr) {
    logWarn("hook selection failed, using base prompt", { error: String(hookErr) });
  }

  try {
    const [fr, en] = await Promise.all([generatePostText(frPrompt), generatePostText(enPrompt)]);
    return { fr, en, hookId };
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) {
      logWarn("anthropic timeout, retrying", { attempt: 1 });
      const retryDelayMs = process.env.NODE_ENV === "test" ? 10 : ANTHROPIC_RETRY_DELAY_MS;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      try {
        const [fr, en] = await Promise.all([generatePostText(frPrompt), generatePostText(enPrompt)]);
        return { fr, en, hookId };
      } catch (retryErr) {
        logError("anthropic failed after retry", { error: String(retryErr) });
        throw retryErr;
      }
    }
    throw err;
  }
}

interface GenerateDraftResult {
  draftId: number;
  postText: string;
  postTextEn: string;
  imagePath: string | null;
  imageUrl: string | null;
  imageUrls: string[];
}

/**
 * Pick between 1 and min(5, available) random images from a product row.
 * Varies both count and order so auto-generated posts don't all look identical.
 * Returns [] if no images are available.
 */
export function pickRandomImages(product: { image1?: string; image2?: string; image3?: string; image4?: string; image5?: string; image6?: string; image7?: string }): string[] {
  const candidates: string[] = [];
  const keys = ["image1", "image2", "image3", "image4", "image5", "image6", "image7"] as const;
  for (const key of keys) {
    const v = product[key];
    if (typeof v === "string" && v.trim().length > 0) candidates.push(v.trim());
  }
  if (candidates.length === 0) return [];
  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const maxPick = Math.min(5, candidates.length);
  const n = 1 + Math.floor(Math.random() * maxPick);
  return candidates.slice(0, n);
}

interface BrandedImages {
  /** True when a branded preview URL was produced and prepended. */
  applied: boolean;
  imageUrls: string[];
  imageUrl: string | null;
  imagePath: string | null;
}

/**
 * Build the branded hero image for a draft (new_product / stock_highlight).
 *
 * The branded image is served by GET /api/image-preview, which composes the
 * product photo + Ameublo Direct logo + price (+ "NOUVEAU" badge for new
 * products). We prepend that public URL as imageUrls[0] so the publisher posts
 * the branded image first, keeping the raw Aosom photos as a gallery, and store
 * the same URL in image_path as a reference (not base64 — the Graph APIs fetch
 * the URL themselves).
 *
 * Returns applied=false when no public base URL is configured (e.g. local dev
 * without NEXT_PUBLIC_APP_URL) so callers fall back to the legacy overlay rather
 * than emit a localhost URL the platforms can't reach.
 *
 * The stored URL uses locale=fr (Ameublo). The publisher rewrites it per channel
 * (localizeBrandedImageUrls in social-publisher.ts) so EN channels (Furnish Direct)
 * fetch the EN-branded variant — one draft, correct logo on each page.
 */
function brandImages(
  trigger: "new_product" | "stock_highlight",
  sku: string,
  price: number,
  rawImageUrls: string[]
): BrandedImages {
  const base = getPublicAppUrl();
  const rawPrimary = rawImageUrls[0] ?? null;
  if (!base || rawImageUrls.length === 0) {
    return { applied: false, imageUrls: rawImageUrls, imageUrl: rawPrimary, imagePath: null };
  }
  // Price goes in the URL so the composed image is cache-keyed on it — otherwise
  // the CDN could serve a stale price after the product's price changes.
  const params = new URLSearchParams({ sku, locale: "fr", price: Number(price).toFixed(2) });
  if (trigger === "new_product") params.set("badge", "new");
  const brandedUrl = `${base}/api/image-preview?${params.toString()}`;
  return {
    applied: true,
    imageUrls: [brandedUrl, ...rawImageUrls],
    imageUrl: brandedUrl,
    imagePath: brandedUrl,
  };
}

/**
 * Generate a social draft for a new product import.
 */
export async function triggerNewProduct(sku: string): Promise<GenerateDraftResult> {
  log(`new_product trigger for ${sku}`);
  const settings = await getAllSettings();
  const product = await getProduct(sku);
  if (!product) throw new Error(`Product ${sku} not found`);
  const productName = (product.name as string) || sku;

  const { fr, en, hookId } = await generateBilingual(settings, "new_product", {
    product_name: productName,
    price: String(product.price),
    store_name: env.storeName,
  }, product.product_type as string | null);

  const imgSettings = getImageSettings(settings);
  const rawImageUrls = pickRandomImages(product);
  const branded = brandImages("new_product", sku, Number(product.price), rawImageUrls);
  let imagePath = branded.imagePath;
  if (!branded.applied && rawImageUrls[0]) {
    // No public base URL — fall back to the legacy overlay preview.
    try {
      imagePath = await composeImage({
        sku,
        templateType: "new_product",
        productName,
        imageUrl: rawImageUrls[0],
        price: Number(product.price),
        language: "FR",
        ...imgSettings,
      });
    } catch (err) {
      log(`Image composition failed for ${sku}: ${err}`);
    }
  }

  const draftId = await createFacebookDraft({
    sku,
    triggerType: "new_product",
    language: "FR",
    postText: fr,
    postTextEn: en,
    imagePath,
    imageUrl: branded.imageUrl,
    imageUrls: branded.imageUrls,
    hookId,
  });

  await markProductPosted(sku);
  await createNotification("info", "Nouveau draft social", `Nouveau produit: ${productName.slice(0, 60)}`);
  log(`Draft #${draftId} created for new product ${sku} (${branded.imageUrls.length} photos, branded=${branded.applied})`);
  return { draftId, postText: fr, postTextEn: en, imagePath, imageUrl: branded.imageUrl, imageUrls: branded.imageUrls };
}

/**
 * Generate a social draft for a significant price drop.
 */
export async function triggerPriceDrop(
  sku: string,
  oldPrice: number,
  newPrice: number
): Promise<GenerateDraftResult> {
  log(`price_drop trigger for ${sku}: ${oldPrice}$ -> ${newPrice}$`);
  const settings = await getAllSettings();
  const product = await getProduct(sku);
  if (!product) throw new Error(`Product ${sku} not found`);
  const productName = (product.name as string) || sku;

  const { fr, en, hookId } = await generateBilingual(settings, "price_drop", {
    product_name: productName,
    price: String(newPrice),
    old_price: String(oldPrice),
    new_price: String(newPrice),
    store_name: env.storeName,
  }, product.product_type as string | null);

  const imgSettings = getImageSettings(settings);
  let imagePath: string | null = null;
  const imageUrls = pickRandomImages(product);
  const imageUrl = imageUrls[0] ?? null;
  if (imageUrl) {
    try {
      imagePath = await composeImage({
        sku,
        templateType: "price_drop",
        productName,
        imageUrl,
        price: newPrice,
        oldPrice,
        language: "FR",
        ...imgSettings,
      });
    } catch (err) {
      log(`Image composition failed for ${sku}: ${err}`);
    }
  }

  const draftId = await createFacebookDraft({
    sku,
    triggerType: "price_drop",
    language: "FR",
    postText: fr,
    postTextEn: en,
    imagePath,
    imageUrl,
    imageUrls,
    oldPrice,
    newPrice,
    hookId,
  });

  await createNotification(
    "info",
    "Draft prix réduit",
    `${productName.slice(0, 40)}: ${oldPrice}$ -> ${newPrice}$`
  );
  log(`Draft #${draftId} created for price drop ${sku} (${imageUrls.length} photos)`);
  return { draftId, postText: fr, postTextEn: en, imagePath, imageUrl, imageUrls };
}

/**
 * Daily stock highlight: pick a random eligible product and generate a draft.
 */
export async function triggerStockHighlight(): Promise<GenerateDraftResult | null> {
  log("stock_highlight trigger");
  const settings = await getAllSettings();
  const minDays = parseInt(
    settings.social_min_days_between_reposts || SYNC.DEFAULT_MIN_DAYS_BETWEEN_REPOSTS,
    10
  );
  const product = await getEligibleHighlightProduct(minDays);

  if (!product) {
    log("No eligible product for stock highlight");
    return null;
  }

  const sku = product.sku as string;
  const productName = (product.name as string) || sku;

  const { fr, en, hookId } = await generateBilingual(settings, "highlight", {
    product_name: productName,
    price: String(product.price),
    qty: String(product.qty),
    store_name: env.storeName,
  }, product.product_type as string | null);

  const imgSettings = getImageSettings(settings);
  const rawImageUrls = pickRandomImages(product);
  const branded = brandImages("stock_highlight", sku, Number(product.price), rawImageUrls);
  let imagePath = branded.imagePath;
  if (!branded.applied && rawImageUrls[0]) {
    // No public base URL — fall back to the legacy overlay preview.
    try {
      imagePath = await composeImage({
        sku,
        templateType: "stock_highlight",
        productName,
        imageUrl: rawImageUrls[0],
        price: Number(product.price),
        qty: Number(product.qty),
        language: "FR",
        ...imgSettings,
      });
    } catch (err) {
      log(`Image composition failed for ${sku}: ${err}`);
    }
  }

  const draftId = await createFacebookDraft({
    sku,
    triggerType: "stock_highlight",
    language: "FR",
    postText: fr,
    postTextEn: en,
    imagePath,
    imageUrl: branded.imageUrl,
    imageUrls: branded.imageUrls,
    hookId,
  });

  await markProductPosted(sku);
  log(`Draft #${draftId} created for stock highlight ${sku} (${branded.imageUrls.length} photos, branded=${branded.applied})`);
  return { draftId, postText: fr, postTextEn: en, imagePath, imageUrl: branded.imageUrl, imageUrls: branded.imageUrls };
}

// ─── Auto-post orchestration ────────────────────────────────────────

/**
 * If auto-post is enabled AND the daily limit isn't reached AND the draft's price drop
 * percentage meets the configured threshold, publish the draft to the configured channels.
 *
 * Non-throwing: logs errors instead of interrupting the sync.
 */
export async function maybeAutopostPriceDrop(
  draftId: number,
  oldPrice: number,
  newPrice: number
): Promise<{ published: boolean; reason?: string }> {
  try {
    const settings = await getAllSettings();
    if (settings.social_autopost_enabled !== "true") {
      return { published: false, reason: "autopost disabled" };
    }

    const pctDrop = oldPrice > 0 ? ((oldPrice - newPrice) / oldPrice) * 100 : 0;
    const minPct = parseFloat(settings.social_autopost_min_drop_percent || "15");
    if (pctDrop < minPct) {
      return { published: false, reason: `drop ${pctDrop.toFixed(1)}% < threshold ${minPct}%` };
    }

    const maxPerDay = parseInt(settings.social_autopost_max_per_day || "5", 10);
    const current = await getAutopostCountToday();
    if (current >= maxPerDay) {
      log(`Autopost daily limit reached (${current}/${maxPerDay}), skipping draft #${draftId}`);
      return { published: false, reason: "daily limit reached" };
    }

    const channelsStr = settings.social_autopost_channels || "fb_ameublo,fb_furnish,ig_ameublo";
    const validKeys = new Set<string>(Object.values(CHANNELS));
    const keys = channelsStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => validKeys.has(s)) as ChannelKey[];
    if (keys.length === 0) return { published: false, reason: "no channels configured" };

    log(`Autopost draft #${draftId} to ${keys.join(",")} (drop ${pctDrop.toFixed(1)}%)`);
    const results = await publishDraftToChannels(draftId, keys);
    const anyOk = results.some((r) => r.state.status === "published");
    if (anyOk) await incrementAutopostCountToday();
    const errs = results.filter((r) => r.state.status === "error");
    if (errs.length > 0) {
      log(`Autopost draft #${draftId}: ${errs.length} channel error(s): ${errs.map((e) => `${e.channel}=${e.state.error}`).join("; ")}`);
      await createNotification(
        "warning",
        "Autopost partiel",
        `Draft #${draftId}: ${errs.length} canal(aux) en erreur`
      );
    }
    return { published: anyOk };
  } catch (err) {
    log(`Autopost failed for draft #${draftId}: ${err}`);
    return { published: false, reason: String(err) };
  }
}

// processScheduledDrafts() and its /api/cron/social-scheduled route were removed when the
// social-scheduled cron was retired: all scheduling now flows through publication_queue,
// published by /api/cron/publisher. See the publication-scheduling section in CLAUDE.md.
