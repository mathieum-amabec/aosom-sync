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
import { budgetedCreate } from "@/lib/llm-budget";
import { cleanSocialCaption } from "@/lib/strip-markdown";
import { env, CLAUDE, SYNC, CHANNELS, type ChannelKey } from "@/lib/config";
import {
  getAllSettings,
  getProduct,
  createFacebookDraft,
  getEligibleHighlightCandidates,
  getPendingSocialCandidates,
  markProductPosted,
  createNotification,
  getAutopostCountToday,
  incrementAutopostCountToday,
} from "@/lib/database";
import { selectHook, buildHookedPrompt, buildHookedPromptEn } from "@/lib/hook-selector";
import { publishDraftToChannels } from "@/lib/social-publisher";
import { resolveLifestyle } from "@/lib/selectors/shopify-images";

// How many eligible products to sample when hunting for a lifestyle-verified one
// for the daily stock highlight. ~80% of the catalog is tagged, so a handful of
// Shopify tag lookups (throttled 2/s, 5-min cached) almost always yields a match.
const HIGHLIGHT_LIFESTYLE_SAMPLE = 15;

// Daily social batch: how many posts to generate per run (cron + manual button).
export const SOCIAL_DAILY_BATCH = 3;
// Soft wall-clock budget for a batch, kept under the cron's maxDuration (300s).
const SOCIAL_BATCH_BUDGET_MS = 250_000;
// Pending-sweep window (days) for "recently imported" + "recently price-dropped",
// and how many of each kind to sample when hunting for a lifestyle-verified one.
const PENDING_WINDOW_DAYS = 7;
const PENDING_SAMPLE_PER_KIND = 12;

/**
 * Gate + source resolver: returns the product's clean Shopify position-1 photo URL
 * when it is `lifestyle-verified` AND actually resolves to a clean cdn.shopify.com
 * photo, else null (→ skip, never post). Returning the URL (not just a bool) lets the
 * caller pass it to image-preview via `?img=`, so the composed hero never depends on
 * a second render-time Shopify lookup (no blip→white-bg, no public amplification).
 * Never throws.
 */
async function postableLifestyleUrl(shopifyProductId: string | null | undefined): Promise<string | null> {
  const life = await resolveLifestyle((shopifyProductId ?? "").trim());
  return life.verified && life.primaryImageUrl ? life.primaryImageUrl : null;
}

// Job 4 generates STATIC posts only: the product's clean Shopify position-1
// lifestyle photo, posted RAW (no compositing, watermark, price footer or badge —
// Mat, 2026-07). Video generation is decoupled: the FFmpeg-based slideshow pipeline
// owns video rendering and populates the draft's video_url separately. See
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
  const message = await budgetedCreate(client,
    {
      model: CLAUDE.MODEL,
      max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: AbortSignal.timeout(ANTHROPIC_CALL_TIMEOUT_MS) },
  );
  log("anthropic call completed", { duration_ms: Date.now() - t0 });
  // Clean the caption: strip Markdown (FB renders **, #, --- literally) and any
  // leading platform-label line ("Post Facebook 🌿") the model prepends.
  return message.content[0]?.type === "text" ? cleanSocialCaption(message.content[0].text) : "";
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
 * Generate a social draft for a new product import.
 */
export async function triggerNewProduct(sku: string): Promise<GenerateDraftResult | null> {
  log(`new_product trigger for ${sku}`);
  const settings = await getAllSettings();
  const product = await getProduct(sku);
  if (!product) throw new Error(`Product ${sku} not found`);
  const productName = (product.name as string) || sku;

  // Only post lifestyle-verified products with a resolvable clean photo (never a
  // white-bg image). New imports are typically untagged until the lifestyle
  // classification runs, so most new_product triggers skip here — that is intended.
  const lifestyleUrl = await postableLifestyleUrl(product.shopify_product_id);
  if (!lifestyleUrl) {
    log(`Skip new_product ${sku}: not lifestyle-verified (or no clean photo)`);
    return null;
  }

  const { fr, en, hookId } = await generateBilingual(settings, "new_product", {
    product_name: productName,
    price: String(product.price),
    store_name: env.storeName,
  }, product.product_type as string | null);

  // Post the clean Shopify position-1 lifestyle photo RAW — the Graph APIs fetch
  // this URL directly; no compositing, watermark, price footer or badge.
  const imageUrls = [lifestyleUrl];

  const draftId = await createFacebookDraft({
    sku,
    triggerType: "new_product",
    language: "FR",
    postText: fr,
    postTextEn: en,
    imagePath: lifestyleUrl,
    imageUrl: lifestyleUrl,
    imageUrls,
    hookId,
  });

  await markProductPosted(sku);
  await createNotification("info", "Nouveau draft social", `Nouveau produit: ${productName.slice(0, 60)}`);
  log(`Draft #${draftId} created for new product ${sku} (raw lifestyle photo)`);
  return { draftId, postText: fr, postTextEn: en, imagePath: lifestyleUrl, imageUrl: lifestyleUrl, imageUrls };
}

/**
 * Generate a social draft for a significant price drop.
 */
export async function triggerPriceDrop(
  sku: string,
  oldPrice: number,
  newPrice: number
): Promise<GenerateDraftResult | null> {
  log(`price_drop trigger for ${sku}: ${oldPrice}$ -> ${newPrice}$`);
  const settings = await getAllSettings();
  const product = await getProduct(sku);
  if (!product) throw new Error(`Product ${sku} not found`);
  const productName = (product.name as string) || sku;

  // Only post lifestyle-verified products with a resolvable clean photo.
  const lifestyleUrl = await postableLifestyleUrl(product.shopify_product_id);
  if (!lifestyleUrl) {
    log(`Skip price_drop ${sku}: not lifestyle-verified (or no clean photo)`);
    return null;
  }

  const { fr, en, hookId } = await generateBilingual(settings, "price_drop", {
    product_name: productName,
    price: String(newPrice),
    old_price: String(oldPrice),
    new_price: String(newPrice),
    store_name: env.storeName,
  }, product.product_type as string | null);

  // Post the clean Shopify position-1 lifestyle photo RAW; the sale caption carries
  // the old→new price (no price footer / badge baked into the image anymore).
  const imageUrls = [lifestyleUrl];

  const draftId = await createFacebookDraft({
    sku,
    triggerType: "price_drop",
    language: "FR",
    postText: fr,
    postTextEn: en,
    imagePath: lifestyleUrl,
    imageUrl: lifestyleUrl,
    imageUrls,
    oldPrice,
    newPrice,
    hookId,
  });

  // Mark posted so the same product can't be re-picked as a stock_highlight in the
  // same batch run (matches triggerNewProduct / stock_highlight).
  await markProductPosted(sku);

  await createNotification(
    "info",
    "Draft prix réduit",
    `${productName.slice(0, 40)}: ${oldPrice}$ -> ${newPrice}$`
  );
  log(`Draft #${draftId} created for price drop ${sku} (raw lifestyle photo)`);
  return { draftId, postText: fr, postTextEn: en, imagePath: lifestyleUrl, imageUrl: lifestyleUrl, imageUrls };
}

/**
 * Generate ONE stock-highlight draft: sample a random eligible batch, post the
 * first lifestyle-verified product (raw pos-1 photo). Returns null when the whole
 * sample is unverified or nothing is eligible. Never notifies — the batch wrapper
 * decides whether an empty run warrants a warning.
 */
async function generateOneStockHighlight(
  settings: Awaited<ReturnType<typeof getAllSettings>>,
  minDays: number,
): Promise<GenerateDraftResult | null> {
  // Sample a small random batch of eligible products, then post the first that is
  // lifestyle-verified. A non-verified product is skipped (never posted with a
  // white-bg image) — matching the new_product / price_drop gate.
  const candidates = await getEligibleHighlightCandidates(minDays, HIGHLIGHT_LIFESTYLE_SAMPLE);
  if (candidates.length === 0) {
    log("No eligible product for stock highlight");
    return null;
  }
  let product: Record<string, unknown> | null = null;
  let lifestyleUrl: string | null = null;
  for (const candidate of candidates) {
    const url = await postableLifestyleUrl(candidate.shopify_product_id as string | null);
    if (url) {
      product = candidate;
      lifestyleUrl = url;
      break;
    }
  }
  if (!product || !lifestyleUrl) {
    log(`No lifestyle-verified product among ${candidates.length} eligible candidates`);
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

  // Post the clean Shopify position-1 lifestyle photo RAW.
  const imageUrls = [lifestyleUrl];

  const draftId = await createFacebookDraft({
    sku,
    triggerType: "stock_highlight",
    language: "FR",
    postText: fr,
    postTextEn: en,
    imagePath: lifestyleUrl,
    imageUrl: lifestyleUrl,
    imageUrls,
    hookId,
  });

  await markProductPosted(sku);
  log(`Draft #${draftId} created for stock highlight ${sku} (raw lifestyle photo)`);
  return { draftId, postText: fr, postTextEn: en, imagePath: lifestyleUrl, imageUrl: lifestyleUrl, imageUrls };
}

/**
 * Daily stock highlight — generate up to `count` distinct highlights. Each posted
 * product is marked (markProductPosted) so subsequent picks in the same run differ.
 * Stops early if a sample yields no lifestyle-verified product (retrying the same
 * run won't help), and surfaces a warning only when nothing at all was produced.
 */
export async function triggerStockHighlight(count = 1): Promise<GenerateDraftResult[]> {
  log(`stock_highlight trigger (count=${count})`);
  const settings = await getAllSettings();
  const minDays = parseInt(
    settings.social_min_days_between_reposts || SYNC.DEFAULT_MIN_DAYS_BETWEEN_REPOSTS,
    10
  );
  const results: GenerateDraftResult[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    const r = await generateOneStockHighlight(settings, minDays);
    if (!r) break;
    results.push(r);
  }
  if (results.length === 0) {
    await createNotification(
      "warning",
      "Stock highlight ignoré",
      "Aucun produit lifestyle-verified parmi les candidats échantillonnés"
    );
  }
  return results;
}

/**
 * Daily social batch orchestrator (cron + manual "Generate Highlights" button).
 * FIX for the "sync/import no longer generates posts" regression: the per-event
 * triggers (new_product on import, price_drop on sync) drop the event when the
 * product isn't lifestyle-verified YET (verification runs later). This sweeps
 * products that have SINCE become verified — recently imported first, then recent
 * significant price drops — and tops up with random stock highlights until `count`
 * drafts exist. The lifestyle-verified gate is applied by the triggers themselves.
 */
export async function generateSocialBatch(count = SOCIAL_DAILY_BATCH): Promise<GenerateDraftResult[]> {
  const settings = await getAllSettings();
  const dropThreshold = parseFloat(
    settings.social_price_drop_threshold || SYNC.DEFAULT_PRICE_DROP_THRESHOLD
  );
  const minDays = parseInt(
    settings.social_min_days_between_reposts || SYNC.DEFAULT_MIN_DAYS_BETWEEN_REPOSTS,
    10
  );

  // Soft time budget: leave headroom under the cron maxDuration so a slow Anthropic
  // draft can't get the function hard-killed mid-batch. Once exceeded, stop starting
  // new drafts and return what we have.
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > SOCIAL_BATCH_BUDGET_MS;

  const results: GenerateDraftResult[] = [];

  const pending = await getPendingSocialCandidates(
    minDays,
    dropThreshold,
    PENDING_WINDOW_DAYS,
    PENDING_SAMPLE_PER_KIND
  );
  for (const c of pending) {
    if (results.length >= count || overBudget()) break;
    try {
      const r =
        c.kind === "new_product"
          ? await triggerNewProduct(c.sku)
          : await triggerPriceDrop(c.sku, c.oldPrice ?? 0, c.newPrice ?? 0);
      if (r) results.push(r);
    } catch (err) {
      // A single bad candidate (Anthropic hiccup, missing product) must not abort the
      // batch or skip the stock-highlight fallback below.
      log(`pending ${c.kind} ${c.sku} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fill the rest with random stock highlights. Not caught: a throw here is a
  // systemic failure (e.g. Anthropic outage) that should surface as a cron 500.
  if (results.length < count && !overBudget()) {
    const fill = await triggerStockHighlight(count - results.length);
    results.push(...fill);
  }

  log(`social batch: ${results.length}/${count} drafts (${pending.length} pending candidates swept)`);
  return results;
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
