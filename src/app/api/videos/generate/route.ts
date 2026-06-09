/**
 * POST /api/videos/generate — generate a real video with the FFmpeg slideshow engine.
 *
 * Body: { engine: 'ffmpeg', productSkus: string[1..6], locale: 'fr'|'en' }
 *
 * Flow (async): create the video_job (status=generating), fetch the products,
 * then render in the background via `after()` so the response returns the jobId
 * immediately. On success → status=ready + video_path/video_url; on failure →
 * status=error + error_message. The dashboard polls GET /api/videos/:id/status.
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
import { generateSlideshowVideo } from "@/lib/video-engines/ffmpeg-slideshow";
import {
  parseGenerateRequest,
  toSlideshowProducts,
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

    // Persist to durable storage so the serve route works across Vercel instances.
    // With a Blob token: upload the MP4 and use its permanent URL. Without one
    // (local dev): fall back to the serve route, which streams the /tmp file.
    let videoUrl = videoServeUrl(jobId);
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const fileBuffer = await readFile(outputPath);
        const blob = await put(`videos/video-${jobId}.mp4`, fileBuffer, {
          access: "public",
          contentType: "video/mp4",
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        videoUrl = blob.url;
      } catch (uploadErr) {
        // Don't waste a good render on a transient Blob failure: keep the job
        // ready and serve the on-disk file (works same-instance / local dev).
        // Logged loudly so a misconfigured/expired token is visible — on Vercel
        // this is best-effort until the instance recycles.
        console.error(`[API] Blob upload failed for job ${jobId}, serving from disk:`, uploadErr);
      }
    }

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
  const { productSkus, locale } = parsed.value;

  // Fetch the products (preserving request order), drop any that don't exist.
  const rows = (await Promise.all(productSkus.map((sku) => getProduct(sku)))).filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "No products found for the given SKUs" }, { status: 400 });
  }
  const products = toSlideshowProducts(rows as ProductLike[]);

  // Record the job, flip it to generating, and kick off the render in the
  // background so we can return the jobId immediately.
  const job = await createVideoJob({
    engine: "ffmpeg",
    contentType: "product",
    productSkus,
    locale,
  });
  await updateVideoJob(job.id, { status: "generating" });

  const outputPath = resolveVideoOutputPath(job.id);
  after(() => runFfmpegGeneration(job.id, products, locale, outputPath));

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
