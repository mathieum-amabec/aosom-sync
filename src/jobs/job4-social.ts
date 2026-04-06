/**
 * Job 4 — Social Media Draft Generator
 *
 * 3 triggers:
 * - new_product: called after Job 3 imports a product
 * - price_drop: called by Job 1 when price drops >= threshold
 * - stock_highlight: daily cron picks a random eligible product
 */
import Anthropic from "@anthropic-ai/sdk";
import { composeImage, type TemplateType } from "@/lib/image-composer";
import {
  getSetting,
  getAllSettings,
  getProduct,
  createFacebookDraft,
  getEligibleHighlightProduct,
  markProductPosted,
} from "@/lib/database";

function log(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[JOB4][${ts}] ${msg}`);
}

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
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
  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  return message.content[0].type === "text" ? message.content[0].text.trim() : "";
}

interface GenerateDraftResult {
  draftId: number;
  language: string;
  postText: string;
  imagePath: string | null;
}

/**
 * Generate a social draft for a new product import.
 */
export async function triggerNewProduct(sku: string): Promise<GenerateDraftResult> {
  log(`new_product trigger for ${sku}`);
  const settings = getAllSettings();
  const product = getProduct(sku);
  if (!product) throw new Error(`Product ${sku} not found`);

  const lang = (settings.social_default_language || "FR") as "FR" | "EN";
  const promptKey = `prompt_new_product_${lang.toLowerCase()}`;
  const template = settings[promptKey] || "Write a Facebook post for: {product_name}";
  const hashtagsKey = `social_hashtags_${lang.toLowerCase()}`;

  const prompt = interpolatePrompt(template, {
    product_name: product.name as string,
    price: String(product.price),
    hashtags: settings[hashtagsKey] || "",
    store_name: process.env.NEXT_PUBLIC_STORE_NAME || "Aosom Sync",
  });

  const postText = await generatePostText(prompt);

  let imagePath: string | null = null;
  const imageUrl = product.image1 as string;
  if (imageUrl) {
    try {
      imagePath = await composeImage({
        sku,
        templateType: "new_product",
        productName: product.name as string,
        imageUrl,
        price: Number(product.price),
        language: lang,
        storeName: process.env.NEXT_PUBLIC_STORE_NAME,
      });
    } catch (err) {
      log(`Image composition failed for ${sku}: ${err}`);
    }
  }

  const draftId = createFacebookDraft({
    sku,
    triggerType: "new_product",
    language: lang,
    postText,
    imagePath,
  });

  markProductPosted(sku);
  log(`Draft #${draftId} created for new product ${sku}`);
  return { draftId, language: lang, postText, imagePath };
}

/**
 * Generate a social draft for a significant price drop.
 */
export async function triggerPriceDrop(
  sku: string,
  oldPrice: number,
  newPrice: number
): Promise<GenerateDraftResult> {
  log(`price_drop trigger for ${sku}: ${oldPrice}$ → ${newPrice}$`);
  const settings = getAllSettings();
  const product = getProduct(sku);
  if (!product) throw new Error(`Product ${sku} not found`);

  const lang = (settings.social_default_language || "FR") as "FR" | "EN";
  const promptKey = `prompt_price_drop_${lang.toLowerCase()}`;
  const template = settings[promptKey] || "Write a Facebook post for a price drop on: {product_name}";
  const hashtagsKey = `social_hashtags_${lang.toLowerCase()}`;

  const prompt = interpolatePrompt(template, {
    product_name: product.name as string,
    price: String(newPrice),
    old_price: String(oldPrice),
    new_price: String(newPrice),
    hashtags: settings[hashtagsKey] || "",
    store_name: process.env.NEXT_PUBLIC_STORE_NAME || "Aosom Sync",
  });

  const postText = await generatePostText(prompt);

  let imagePath: string | null = null;
  const imageUrl = product.image1 as string;
  if (imageUrl) {
    try {
      imagePath = await composeImage({
        sku,
        templateType: "price_drop",
        productName: product.name as string,
        imageUrl,
        price: newPrice,
        oldPrice,
        language: lang,
        storeName: process.env.NEXT_PUBLIC_STORE_NAME,
      });
    } catch (err) {
      log(`Image composition failed for ${sku}: ${err}`);
    }
  }

  const draftId = createFacebookDraft({
    sku,
    triggerType: "price_drop",
    language: lang,
    postText,
    imagePath,
    oldPrice,
    newPrice,
  });

  log(`Draft #${draftId} created for price drop ${sku}`);
  return { draftId, language: lang, postText, imagePath };
}

/**
 * Daily stock highlight: pick a random eligible product and generate a draft.
 */
export async function triggerStockHighlight(): Promise<GenerateDraftResult | null> {
  log("stock_highlight trigger");
  const settings = getAllSettings();
  const minDays = parseInt(settings.social_min_days_between_reposts || "30", 10);
  const product = getEligibleHighlightProduct(minDays);

  if (!product) {
    log("No eligible product for stock highlight");
    return null;
  }

  const sku = product.sku as string;
  const lang = (settings.social_default_language || "FR") as "FR" | "EN";
  const promptKey = `prompt_highlight_${lang.toLowerCase()}`;
  const template = settings[promptKey] || "Write a Facebook post highlighting: {product_name}";
  const hashtagsKey = `social_hashtags_${lang.toLowerCase()}`;

  const prompt = interpolatePrompt(template, {
    product_name: product.name as string,
    price: String(product.price),
    qty: String(product.qty),
    hashtags: settings[hashtagsKey] || "",
    store_name: process.env.NEXT_PUBLIC_STORE_NAME || "Aosom Sync",
  });

  const postText = await generatePostText(prompt);

  let imagePath: string | null = null;
  const imageUrl = product.image1 as string;
  if (imageUrl) {
    try {
      imagePath = await composeImage({
        sku,
        templateType: "stock_highlight",
        productName: product.name as string,
        imageUrl,
        price: Number(product.price),
        qty: Number(product.qty),
        language: lang,
        storeName: process.env.NEXT_PUBLIC_STORE_NAME,
      });
    } catch (err) {
      log(`Image composition failed for ${sku}: ${err}`);
    }
  }

  const draftId = createFacebookDraft({
    sku,
    triggerType: "stock_highlight",
    language: lang,
    postText,
    imagePath,
  });

  markProductPosted(sku);
  log(`Draft #${draftId} created for stock highlight ${sku}`);
  return { draftId, language: lang, postText, imagePath };
}
