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
 * serve request may land on different instances. Uploading the MP4 to durable
 * storage (Vercel Blob) and setting an absolute video_url is the production
 * follow-up; the serve route already 302-redirects when video_url is an http URL.
 */
import { NextResponse, after } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { createVideoJob, updateVideoJob, getProduct } from "@/lib/database";
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
    await updateVideoJob(jobId, {
      status: "ready",
      video_path: outputPath,
      video_url: videoServeUrl(jobId),
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
    await updateVideoJob(jobId, {
      status: "ready",
      video_path: finalPath,
      video_url: videoServeUrl(jobId),
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
    const products = toSlideshowProducts(rows as ProductLike[]);
    after(() => runFfmpegGeneration(job.id, products, locale, outputPath));
  }

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
