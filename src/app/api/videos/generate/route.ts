/**
 * POST /api/videos/generate — render a real video into a video_job.
 *
 * Body: { engine: 'ffmpeg' | 'kling', productSkus: string[1..6], locale: 'fr'|'en' }
 *   - ffmpeg: branded slideshow from 1-6 product photos.
 *   - kling:  AI image→video clip from the first product's hero photo.
 *
 * Flow (async): create the video_job (status=generating), fetch the products,
 * then render in the background via `after()` so the response returns the jobId
 * immediately. Both engines write the MP4 to video_jobs.video_path (+ a
 * video_serve video_url). On success → status=ready; on failure → status=error
 * + error_message. The dashboard polls GET /api/videos/:id/status.
 *
 * The render (sharp + ffmpeg) is heavy, so this runs on the Node.js runtime with
 * a long maxDuration. The MP4 is written to the local filesystem (/tmp on Vercel)
 * and streamed back by GET /api/video-serve/:id.
 *
 * NOTE (Vercel): /tmp is per-instance and ephemeral, so a render and a later
 * serve request may land on different instances. To make the video durable we
 * upload the rendered MP4 to Vercel Blob and store its permanent absolute URL in
 * video_url; the serve route 302-redirects to it. When no Blob token is set
 * (local dev) we skip the upload and the serve route streams the /tmp file.
 */
import { NextResponse, after } from "next/server";
import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { createVideoJob, updateVideoJob, getProduct } from "@/lib/database";
import { resolveProductImages } from "@/lib/selectors";
import { generateSlideshowVideo } from "@/lib/video-engines/ffmpeg-slideshow";
import { generateKlingVideo, isKlingConfigured, type KlingProduct } from "@/lib/video-engines/kling-client";
import {
  parseGenerateRequest,
  toSlideshowProducts,
  toKlingProduct,
  resolveVideoOutputPath,
  videoServeUrl,
  type ProductLike,
} from "@/lib/video-engines/video-generate";
import type { SlideshowProduct, VideoLocale } from "@/lib/video-engines/ffmpeg-slideshow";

export const runtime = "nodejs";
// Slideshow renders (download + sharp + ffmpeg) can take well over a minute.
export const maxDuration = 300;

/**
 * Resolve the durable video_url for a finished render (shared by both engines).
 * With a Blob token: upload the MP4 and return its permanent URL so the serve
 * route works across Vercel instances. Without one (local dev) or on a transient
 * upload failure: fall back to the serve route, which streams the on-disk /tmp
 * file. A Blob failure is logged loudly (misconfigured/expired token) but never
 * wastes a good render — the job stays ready, served from disk.
 */
async function resolveDurableVideoUrl(jobId: number, filePath: string): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return videoServeUrl(jobId);
  try {
    const fileBuffer = await readFile(filePath);
    const blob = await put(`videos/video-${jobId}.mp4`, fileBuffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return blob.url;
  } catch (uploadErr) {
    console.error(`[API] Blob upload failed for job ${jobId}, serving from disk:`, uploadErr);
    return videoServeUrl(jobId);
  }
}

/**
 * Background render: produce the MP4 and move the job to ready/error.
 * Exported for unit testing; never throws (errors are recorded on the job).
 */
export async function runFfmpegGeneration(
  jobId: number,
  products: SlideshowProduct[],
  locale: VideoLocale,
  outputPath: string,
): Promise<void> {
  try {
    await generateSlideshowVideo({ products, locale, outputPath });
    const videoUrl = await resolveDurableVideoUrl(jobId, outputPath);
    await updateVideoJob(jobId, {
      status: "ready",
      video_path: outputPath,
      video_url: videoUrl,
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error(`[API] video generation failed for job ${jobId}:`, err);
    await updateVideoJob(jobId, { status: "error", error_message: message });
  }
}

/**
 * Background render for the Kling engine: generate the branded clip and move the
 * job to ready/error. generateKlingVideo returns null when it no-ops (no usable
 * image, render timeout, API failure) — recorded as an error so the dashboard
 * surfaces it rather than leaving the job stuck in "generating".
 * Exported for unit testing; never throws.
 */
export async function runKlingGeneration(
  jobId: number,
  product: KlingProduct,
  locale: VideoLocale,
  outputPath: string,
): Promise<void> {
  try {
    const finalPath = await generateKlingVideo({ product, locale, outputPath });
    if (!finalPath) {
      await updateVideoJob(jobId, {
        status: "error",
        error_message: "Kling produced no video (no usable image, API failure, or render timed out)",
      });
      return;
    }
    const videoUrl = await resolveDurableVideoUrl(jobId, finalPath);
    await updateVideoJob(jobId, {
      status: "ready",
      video_path: finalPath,
      video_url: videoUrl,
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error(`[API] kling video generation failed for job ${jobId}:`, err);
    await updateVideoJob(jobId, { status: "error", error_message: message });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseGenerateRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { engine, productSkus, locale } = parsed.value;

  // Fail fast rather than queuing a job that can only error in the background.
  if (engine === "kling" && !isKlingConfigured()) {
    return NextResponse.json({ error: "Kling engine is not configured (KLING_API_KEY missing)" }, { status: 400 });
  }

  // Fetch the products (preserving request order), drop any that don't exist.
  const rows = (await Promise.all(productSkus.map((sku) => getProduct(sku)))).filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "No products found for the given SKUs" }, { status: 400 });
  }

  // Record the job, flip it to generating, and kick off the render in the
  // background so we can return the jobId immediately. Both engines write their
  // MP4 to video_jobs.video_path; GET /api/video-serve/:id streams it back.
  const job = await createVideoJob({ engine, contentType: "product", productSkus, locale });
  await updateVideoJob(job.id, { status: "generating" });
  const outputPath = resolveVideoOutputPath(job.id);

  if (engine === "kling") {
    // Kling renders one cinematic clip from the first resolved product's hero photo.
    const product = toKlingProduct(rows[0] as ProductLike);
    after(() => runKlingGeneration(job.id, product, locale, outputPath));
  } else {
    // Video slides use the live Shopify-CDN image (Aosom CDN 403s the render
    // workers), resolved per product exactly like Moteur A.
    const products = await toSlideshowProducts(rows as ProductLike[], resolveProductImages);
    after(() => runFfmpegGeneration(job.id, products, locale, outputPath));
  }

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
