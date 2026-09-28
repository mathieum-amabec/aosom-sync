import { NextResponse } from "next/server";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { getStudioRender, effectiveStatus } from "@/lib/studio/db";

/** GET /api/studio/render/:id — render status (rendering | ready | error) and, when ready, the video URL. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ success: false, error: "ID invalide" }, { status: 400 });
  const render = await getStudioRender(id);
  if (!render) return NextResponse.json({ success: false, error: "Rendu introuvable" }, { status: 404 });
  const status = effectiveStatus(render);
  return NextResponse.json({
    success: true,
    data: {
      id: render.id,
      status,
      videoUrl: render.videoUrl,
      error: status === "error" && !render.error ? "Le rendu a été interrompu (délai dépassé). Réessaie." : render.error,
      queueId: render.queueId,
      params: render.params,
    },
  });
}
