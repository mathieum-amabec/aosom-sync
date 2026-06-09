/**
 * Pure helpers for the FFmpeg video generation route.
 *
 * Deliberately DB-free (no `@/lib/database` / libsql import) so these can be
 * unit-tested in isolation — the route handler stays thin and delegates request
 * validation, product→slide mapping, and path resolution here.
 */
import path from "path";
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
  image1?: string | null;
  image2?: string | null;
  image3?: string | null;
  image4?: string | null;
  image5?: string | null;
  image6?: string | null;
  image7?: string | null;
}

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

/** First non-empty product image (image1..image7), or null if none. */
export function selectProductImage(row: ProductLike): string | null {
  const keys = ["image1", "image2", "image3", "image4", "image5", "image6", "image7"] as const;
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Map DB product rows to the slideshow's product shape. Rows with no usable
 * image are kept (the engine renders a navy fallback slide), but the result is
 * capped at MAX_VIDEO_PRODUCTS to stay within generateSlideshowVideo's limit.
 */
export function toSlideshowProducts(rows: ProductLike[]): SlideshowProduct[] {
  return rows.slice(0, MAX_VIDEO_PRODUCTS).map((row) => ({
    name: (row.name ?? row.sku ?? "Produit") || "Produit",
    price: typeof row.price === "number" ? row.price : Number(row.price) || 0,
    imageUrl: selectProductImage(row) ?? "",
  }));
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
