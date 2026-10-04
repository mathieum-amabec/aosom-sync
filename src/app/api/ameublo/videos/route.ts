import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { listAmeubloTestVideos, setAmeubloTestVerdict, setAmeubloCaption, getAmeubloTestVideo } from "@/lib/database";
import { approveAmeubloVideo, bulkApproveAmeubloVideos, cancelAmeubloVideo } from "@/lib/ameublo-approval";

/**
 * Studio Ameublo — mascot videos.
 *
 * GET   → every video (newest first) with its schedule state (queue_status / queue_scheduled_at).
 * PATCH { id, verdict: "ok" | "bad" | null, note? } → the operator's verdict. Admin-only.
 * POST  { action: "approve", id, force? }          → plan on the next free slot of its language.
 *       { action: "bulk_approve", ids, force? }    → same, FR/EN interleaved.
 *       { action: "cancel", id }                   → take it off the schedule.
 *       { action: "caption", id, caption }         → edit the caption (not once scheduled).
 * Approval is the operator's action only; reviewers get 403.
 */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const videos = await listAmeubloTestVideos();
  return NextResponse.json({ success: true, data: { videos } });
}

async function adminBody(request: Request): Promise<{ body: Record<string, unknown> } | { res: NextResponse }> {
  if (!(await isAuthenticated())) return { res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((await getSessionRole()) === "reviewer") return { res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  try {
    return { body: (await request.json()) as Record<string, unknown> };
  } catch {
    return { res: NextResponse.json({ error: "JSON invalide" }, { status: 400 }) };
  }
}

export async function PATCH(request: Request) {
  const r = await adminBody(request);
  if ("res" in r) return r.res;
  const body = r.body;
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

export async function POST(request: Request) {
  const r = await adminBody(request);
  if ("res" in r) return r.res;
  const body = r.body;
  const force = body.force === true;
  const id = Number(body.id);

  switch (body.action) {
    case "approve": {
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id requis" }, { status: 400 });
      const res = await approveAmeubloVideo(id, { force });
      return NextResponse.json(res, { status: res.success ? 200 : res.status });
    }
    case "bulk_approve": {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      if (!ids.length || ids.length > 100) return NextResponse.json({ error: "ids requis (1 à 100)" }, { status: 400 });
      const results = await bulkApproveAmeubloVideos(ids, { force });
      return NextResponse.json({
        success: true,
        data: { results, approved: results.filter((x) => x.success).length, refused: results.filter((x) => !x.success).length },
      });
    }
    case "cancel": {
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id requis" }, { status: 400 });
      const res = await cancelAmeubloVideo(id);
      return NextResponse.json(res, { status: res.success ? 200 : 409 });
    }
    case "caption": {
      const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 2000) : "";
      if (!Number.isInteger(id) || id <= 0 || !caption) return NextResponse.json({ error: "id et caption requis" }, { status: 400 });
      const v = await getAmeubloTestVideo(id);
      if (!v) return NextResponse.json({ error: "Vidéo introuvable" }, { status: 404 });
      if (v.queue_status && ["pending", "publishing", "published"].includes(v.queue_status)) {
        return NextResponse.json({ error: "Déjà planifiée : annule d’abord la planification pour modifier la légende." }, { status: 409 });
      }
      await setAmeubloCaption(id, caption);
      return NextResponse.json({ success: true });
    }
    default:
      return NextResponse.json({ error: "action inconnue" }, { status: 400 });
  }
}
