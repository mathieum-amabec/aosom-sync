import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { listAmeubloTestVideos, setAmeubloTestVerdict } from "@/lib/database";

/**
 * Studio Ameublo — mascot test videos (review only, never published).
 *
 * GET   → every test video, newest series first.
 * PATCH { id, verdict: "ok" | "bad" | null, note? } → the operator's verdict. Admin-only.
 */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const videos = await listAmeubloTestVideos();
  return NextResponse.json({ success: true, data: { videos } });
}

export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((await getSessionRole()) === "reviewer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const id = Number(body.id);
  const verdict = body.verdict === "ok" || body.verdict === "bad" ? body.verdict : body.verdict === null ? null : undefined;
  if (!Number.isInteger(id) || id <= 0 || verdict === undefined) {
    return NextResponse.json({ error: "id et verdict (ok, bad ou null) requis" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : undefined;
  const ok = await setAmeubloTestVerdict(id, verdict, note);
  if (!ok) return NextResponse.json({ error: "Vidéo introuvable" }, { status: 404 });
  return NextResponse.json({ success: true });
}
