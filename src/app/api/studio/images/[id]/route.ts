import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { getStudioImage, deleteStudioImage } from "@/lib/studio/db";

/** DELETE /api/studio/images/:id — remove one of Mat's uploads / AI retouches (row + Blob file). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ success: false, error: "ID invalide" }, { status: 400 });
  try {
    const image = await getStudioImage(id);
    if (!image) return NextResponse.json({ success: false, error: "Image introuvable" }, { status: 404 });
    await deleteStudioImage(id);
    // Best effort: a render may still reference the file, and a leftover blob costs nothing visible.
    await del(image.url).catch((e) => console.warn(`[API] studio image ${id}: blob delete failed`, e));
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[API] DELETE /api/studio/images/${id} failed:`, err);
    return NextResponse.json({ success: false, error: "Suppression impossible" }, { status: 500 });
  }
}
