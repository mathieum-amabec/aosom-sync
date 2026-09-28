import { NextResponse } from "next/server";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { getStudioRender, setStudioRenderQueueId, effectiveStatus } from "@/lib/studio/db";
import { addToQueue, ensureSchema } from "@/lib/database";

/**
 * POST /api/studio/render/:id/queue — send a finished render to the publication queue as a
 * `before_after` DRAFT. It then shows up in /content-formats → Avant-Après, where Mat
 * approves it (which picks the next free slot on the before_after grid) or rejects it.
 * scheduled_at is a placeholder: drafts don't reserve a slot; approval computes the real one.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ success: false, error: "ID invalide" }, { status: 400 });
  const render = await getStudioRender(id);
  if (!render) return NextResponse.json({ success: false, error: "Rendu introuvable" }, { status: 404 });
  if (effectiveStatus(render) !== "ready" || !render.videoUrl) {
    return NextResponse.json({ success: false, error: "Le rendu n'est pas prêt" }, { status: 409 });
  }
  if (render.queueId) return NextResponse.json({ success: true, data: { queueId: render.queueId, alreadyQueued: true } });

  try {
    const db = await ensureSchema();
    const priceRow = await db.execute({ sql: `SELECT price FROM products WHERE sku = ?`, args: [render.sku] });
    const price = Number(priceRow.rows[0]?.price ?? 0);
    const p = render.params;
    const queueId = await addToQueue({
      contentType: "before_after",
      contentId: render.sku,
      platform: "facebook",
      payload: JSON.stringify({
        sku: render.sku,
        productName: p.productTitle,
        blobUrl: render.videoUrl,
        price,
        studio: p.before.url,
        life: p.after.url,
        source: "studio",
        format: p.format,
        transition: p.transition,
        renderId: render.id,
      }),
      scheduledAt: `${new Date().getUTCFullYear() + 1}-12-31 12:00:00`,
      status: "draft",
      metadata: { source: "studio", renderId: render.id, format: p.format, transition: p.transition },
    });
    await setStudioRenderQueueId(id, queueId);
    return NextResponse.json({ success: true, data: { queueId } });
  } catch (err) {
    console.error(`[API] studio render ${id} → queue failed:`, err);
    return NextResponse.json({ success: false, error: "Ajout à la file impossible" }, { status: 500 });
  }
}
