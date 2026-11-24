/**
 * GET /api/cron/hot-topics — "sujet chaud" Facebook post (Vercel Cron, Tue + Thu 11:00 UTC).
 *
 * Collects what Québec is talking about (Google Trends QC + local sports desks), keeps only light,
 * brand-safe topics, writes one question post with a red "carte" image and stores it as a DRAFT for
 * human approval. It never approves, schedules or publishes anything.
 *
 * Gated by `settings.hot_topics_mode`: off (default — the cron is a no-op) | dry | live.
 * `?dry=1` forces a dry run even when the mode is off or live (operator preview; writes nothing but
 * the `hot_topics_last_run` audit row). The query string can only downgrade — it can never turn live on.
 *
 * GET, not POST: Vercel Cron only issues GET. Protected by CRON_SECRET (Bearer).
 */
import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runHotTopics, type HotTopicsResult } from "@/lib/hot-topics/run";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function summarize(r: HotTopicsResult): string {
  if (r.skipped) return `${r.mode}: ${r.skipped}`;
  if (r.chosen?.draftId) return `live: draft #${r.chosen.draftId} — ${r.chosen.topic}`.slice(0, 200);
  return `${r.mode}: ${r.chosen ? `plan — ${r.chosen.topic}` : "aucun sujet"}`.slice(0, 200);
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  try {
    const result = await trackCron("hot-topics", () => runHotTopics(dry ? { modeOverride: "dry" } : {}), summarize);
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/hot-topics failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "hot-topics failed" }, { status: 500 });
  }
}
