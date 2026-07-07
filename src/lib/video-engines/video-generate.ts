/**
 * Pure helpers for the FFmpeg video generation route.
 *
 * Deliberately DB-free (no `@/lib/database` / libsql import) so these can be
 * unit-tested in isolation — the route handler stays thin and delegates request
 * validation, product→slide mapping, and path resolution here. The Shopify image
 * resolver is INJECTED (not imported) for the same reason.
 */
import path from "path";
import { isShopifyCdnUrl } from "@/lib/slideshow/validate";
import type { SlideshowProduct, VideoLocale } from "./ffmpeg-slideshow";
import type { KlingProduct } from "./kling-client";

/**
 * Engines this route renders synchronously into a video_job:
 *  - "ffmpeg": branded slideshow from 1-6 product photos.
 *  - "kling":  AI image→video clip from a single product's hero photo.
 * Both write their MP4 to video_jobs.video_path; Creatomate stays on the
 * pending-queue path (/api/videos) until its engine lands.
 */
export const GENERATE_ENGINES = ["ffmpeg", "kling"] as const;
export type GenerateEngine = (typeof GENERATE_ENGINES)[number];
/** generateSlideshowVideo accepts 1-6 products. */
export const MAX_VIDEO_PRODUCTS = 6;

export interface GenerateRequest {
  engine: GenerateEngine;
  productSkus: string[];
  locale: VideoLocale;
}

export type ParseResult =
  | { ok: true; value: GenerateRequest }
  | { ok: false; error: string };

/** Product row fields the slideshow needs (a DB ProductRow is a superset). */
export interface ProductLike {
  sku?: string | null;
  name?: string | null;
  price?: number | string | null;
  /** Live Shopify product id — used to resolve cdn.shopify.com images. */
  shopify_product_id?: string | null;
  image1?: string | null;
  image2?: string | null;
  image3?: string | null;
  image4?: string | null;
  image5?: string | null;
  image6?: string | null;
  image7?: string | null;
}

/** Resolves a product's live Shopify-CDN image URLs (injected so this stays DB-free). */
export type ShopifyImageResolver = (shopifyProductId: string) => Promise<string[]>;

const LOCALES: VideoLocale[] = ["fr", "en"];

/**
 * Validate the POST /api/videos/generate body:
 * `{ engine: 'ffmpeg', productSkus: string[1..6], locale: 'fr'|'en' }`.
 */
export function parseGenerateRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const obj = body as { engine?: unknown; productSkus?: unknown; locale?: unknown };

  if (typeof obj.engine !== "string" || !(GENERATE_ENGINES as readonly string[]).includes(obj.engine)) {
    return { ok: false, error: `\`engine\` must be one of: ${GENERATE_ENGINES.join(", ")}` };
  }
  if (
    !Array.isArray(obj.productSkus) ||
    !obj.productSkus.every((s) => typeof s === "string" && s.trim().length > 0)
  ) {
    return { ok: false, error: "`productSkus` must be a non-empty array of strings" };
  }
  const skus = (obj.productSkus as string[]).map((s) => s.trim());
  if (skus.length < 1) {
    return { ok: false, error: "`productSkus` must contain at least one SKU" };
  }
  if (skus.length > MAX_VIDEO_PRODUCTS) {
    return { ok: false, error: `\`productSkus\` accepts at most ${MAX_VIDEO_PRODUCTS} SKUs` };
  }
  if (typeof obj.locale !== "string" || !(LOCALES as string[]).includes(obj.locale)) {
    return { ok: false, error: `\`locale\` must be one of: ${LOCALES.join(", ")}` };
  }

  return { ok: true, value: { engine: obj.engine as GenerateEngine, productSkus: skus, locale: obj.locale as VideoLocale } };
}

/** First non-empty catalog image (image1..image7 = Aosom CDN), or null if none.
 * Legacy helper: NOT used for video slides anymore (Aosom CDN 403s render workers
 * — video slides use Shopify CDN via toSlideshowProducts). Kept for other callers. */
export function selectProductImage(row: ProductLike): string | null {
  const keys = ["image1", "image2", "image3", "image4", "image5", "image6", "image7"] as const;
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Map DB product rows to the slideshow's product shape.
 *
 * The image is the product's live **cdn.shopify.com** photo, resolved per row via
 * the injected `resolveShopifyImages` — matching Moteur A (build.ts: the first
 * `isShopifyCdnUrl` image). The catalog `image1..7` columns hold Aosom-CDN URLs
 * (`img-us.aosomcdn.com`) which 403 the render workers, so they are NOT used for
 * video slides. A row that has no Shopify image keeps `imageUrl: ""` (the engine
 * renders a navy fallback slide). Capped at MAX_VIDEO_PRODUCTS.
 */
export async function toSlideshowProducts(
  rows: ProductLike[],
  resolveShopifyImages: ShopifyImageResolver,
): Promise<SlideshowProduct[]> {
  const capped = rows.slice(0, MAX_VIDEO_PRODUCTS);
  return Promise.all(
    capped.map(async (row) => {
      const images = await resolveShopifyImages((row.shopify_product_id ?? "").trim());
      return {
        name: (row.name ?? row.sku ?? "Produit") || "Produit",
        price: typeof row.price === "number" ? row.price : Number(row.price) || 0,
        imageUrl: images.find(isShopifyCdnUrl) ?? "",
      };
    }),
  );
}

/** All non-empty product images (image1..image7), in position order. */
export function selectProductImages(row: ProductLike): string[] {
  const keys = ["image1", "image2", "image3", "image4", "image5", "image6", "image7"] as const;
  const out: string[] = [];
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out;
}

/**
 * Map a DB product row to the Kling engine's product shape. Kling renders a
 * single cinematic clip from one product, so the route drives it with the first
 * resolved product; selectBestImage (inside the engine) picks the hero photo.
 */
export function toKlingProduct(row: ProductLike): KlingProduct {
  return {
    name: (row.name ?? row.sku ?? "Produit") || "Produit",
    images: selectProductImages(row),
    sku: row.sku ?? undefined,
  };
}

/**
 * Where the rendered MP4 is written. /tmp on Vercel (the only writable path on
 * the serverless filesystem), else public/social-videos/ for local dev. The
 * file is served back through GET /api/video-serve/:id (streams video_path).
 */
export function resolveVideoOutputPath(jobId: number): string {
  const dir = process.env.VERCEL
    ? path.join("/tmp", "videos")
    : path.join(process.cwd(), "public", "social-videos");
  return path.join(dir, `video-${jobId}.mp4`);
}

/** Dashboard-playable URL for a finished job (served by /api/video-serve/:id). */
export function videoServeUrl(jobId: number): string {
  return `/api/video-serve/${jobId}`;
}
