import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { listAmeubloTestVideos, getOccupiedQueueSlots } from "@/lib/database";
import { approveAmeubloVideoAt } from "@/lib/ameublo-approval";
import { planWeek, isGridSlot, isSeasonalActive, WEEK_SLOTS, type PlanCandidate } from "@/lib/ameublo-week-plan";

/**
 * Studio Ameublo — "Plan de la semaine".
 *
 * GET  ?days=7&exclude=1,2 → the proposed plan for the next days: which not-yet-approved video goes on
 *                            which grid slot. Read-only; `exclude` re-plans without those videos.
 * POST { action: "approve_plan", entries: [{ id, at }] } → approve the entries the operator confirmed,
 *                            each on its explicit slot. Admin-only; every `at` must be a grid slot.
 * Approval is the OPERATOR's action only — nothing here runs from a cron.
 */
async function guard(): Promise<NextResponse | null> {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((await getSessionRole()) === "reviewer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

export async function GET(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const url = new URL(request.url);
  const days = Math.min(14, Math.max(1, Number(url.searchParams.get("days")) || 7));
  const exclude = new Set((url.searchParams.get("exclude") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0));

  const rows = await listAmeubloTestVideos();
  // "new" in the Studio sense: nothing queued, not rejected, not flagged by the QA reviewer.
  const isNew = (v: (typeof rows)[number]) =>
    !(v.queue_id != null && v.queue_status && ["pending", "publishing", "published", "draft"].includes(v.queue_status)) &&
    v.verdict !== "bad" && v.qa_verdict !== "fail" && v.qa_verdict !== "review";
  const pool = rows.filter((v) => !!v.lang && !!v.style && !!v.caption?.trim() && isNew(v));
  const candidates: PlanCandidate[] = pool
    .filter((v) => !exclude.has(v.id))
    .map((v) => ({ id: v.id, lang: v.lang as "fr" | "en", style: v.style as string, campaign: v.campaign, series: v.series, label: v.label }));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = await getOccupiedQueueSlots("both");
  const plan = planWeek({ candidates, occupied, nowSec, days });
  const byId = new Map(rows.map((v) => [v.id, v]));
  const entries = plan.map((e) => {
    const v = byId.get(e.id)!;
    return { ...e, style: v.style, label: v.label, series: v.series, video_url: v.video_url, skus: v.skus };
  });
  return NextResponse.json({
    success: true,
    data: {
      entries,
      slots: WEEK_SLOTS,
      seasonalActive: isSeasonalActive(nowSec),
      stock: { fr: pool.filter((v) => v.lang === "fr").length, en: pool.filter((v) => v.lang === "en").length },
      unplaced: candidates.length - plan.length,
    },
  });
}

export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  if (body.action !== "approve_plan") return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  const entries = Array.isArray(body.entries) ? (body.entries as { id?: unknown; at?: unknown }[]) : [];
  if (!entries.length || entries.length > 100) return NextResponse.json({ error: "entries requis (1 à 100)" }, { status: 400 });

  const rows = await listAmeubloTestVideos();
  const byId = new Map(rows.map((v) => [v.id, v]));
  const nowSec = Math.floor(Date.now() / 1000);
  const results = [];
  for (const e of entries) {
    const id = Number(e.id);
    const at = typeof e.at === "string" ? e.at : "";
    const v = byId.get(id);
    if (!v || !v.lang) { results.push({ success: false, id, error: "Vidéo introuvable.", status: 404 }); continue; }
    if (!isGridSlot(v.lang, at, nowSec)) { results.push({ success: false, id, error: "Créneau hors grille.", status: 400 }); continue; }
    results.push(await approveAmeubloVideoAt(id, at));
  }
  return NextResponse.json({
    success: true,
    data: { results, approved: results.filter((r) => r.success).length, refused: results.filter((r) => !r.success).length },
  });
}
