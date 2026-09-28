import { NextResponse, after } from "next/server";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { put } from "@vercel/blob";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { parseRenderRequest } from "@/lib/studio/options";
import { renderStudioVideo } from "@/lib/studio/render";
import { createStudioRender, finishStudioRender } from "@/lib/studio/db";

export const runtime = "nodejs";
// Download + sharp + ffmpeg: ~10-60 s for a 6-15 s clip; the budget covers a slow cold start.
export const maxDuration = 300;

/**
 * POST /api/studio/render — start rendering Mat's before/after choices. Returns { id } at once;
 * the render runs in `after()` and the page polls GET /api/studio/render/:id. The MP4 goes to
 * the public Blob store (Meta/Facebook fetch it by URL when publishing).
 */
export async function POST(request: Request) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Requête invalide" }, { status: 400 });
  }
  const parsed = parseRenderRequest(body);
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  const req = parsed.value;

  let id: number;
  try {
    id = await createStudioRender(req);
  } catch (err) {
    console.error("[API] studio render: create row failed", err);
    return NextResponse.json({ success: false, error: "Impossible de démarrer le rendu" }, { status: 500 });
  }

  after(async () => {
    const workDir = path.join(os.tmpdir(), `studio-${id}`);
    const outFile = path.join(os.tmpdir(), `studio-${id}.mp4`);
    try {
      await renderStudioVideo(req, workDir, outFile);
      const blob = await put(
        `content-batches/before-after/studio/${req.sku}-${id}-${req.format.replace(":", "x")}.mp4`,
        await readFile(outFile),
        { access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true },
      );
      await finishStudioRender(id, { videoUrl: blob.url });
    } catch (err) {
      console.error(`[studio] render ${id} failed:`, err);
      await finishStudioRender(id, { error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    }
  });

  return NextResponse.json({ success: true, data: { id } });
}
