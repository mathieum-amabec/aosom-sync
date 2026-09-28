import { NextResponse } from "next/server";
import { requireStudioAdmin, isStudioBlobUrl } from "@/lib/studio/guard";
import { addStudioImage } from "@/lib/studio/db";

/** POST /api/studio/images — register a photo Mat just uploaded ({ sku, url }) in the product's Studio gallery. */
export async function POST(request: Request) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  let body: { sku?: unknown; url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Requête invalide" }, { status: 400 });
  }
  const sku = typeof body.sku === "string" ? body.sku.trim().slice(0, 40) : "";
  const url = typeof body.url === "string" ? body.url : "";
  if (!sku || !isStudioBlobUrl(url, ["studio/uploads/"])) {
    return NextResponse.json({ success: false, error: "SKU ou URL invalide" }, { status: 400 });
  }
  try {
    const image = await addStudioImage({ sku, url, source: "upload" });
    return NextResponse.json({ success: true, data: image });
  } catch (err) {
    console.error("[API] /api/studio/images failed:", err);
    return NextResponse.json({ success: false, error: "Enregistrement impossible" }, { status: 500 });
  }
}
