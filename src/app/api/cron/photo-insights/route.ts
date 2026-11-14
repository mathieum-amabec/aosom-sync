import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { listPhotosToMeasure, savePhotoInsight } from "@/lib/photo-insights-store";
import { fetchFacebookPhotoInsights, fetchInstagramPhotoInsights } from "@/lib/photo-insights-client";

/**
 * GET /api/cron/photo-insights — Vercel cron, Bearer CRON_SECRET required. READ-ONLY toward Meta.
 *
 * Once a day, reads the views / reach / reactions / comments / shares of every photo post published in the last 14 days whose
 * Facebook and Instagram ids we recorded at publish time, and stores one snapshot per post per platform per day. Runs just after
 * reel-insights and BEFORE the 06:00 Montreal morning report, so the report's photo section reads this morning's numbers. One
 * failing post (deleted, token hiccup) is counted and skipped; a time budget keeps the run well under maxDuration (newest first).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WINDOW_DAYS = 14;
const BUDGET_MS = 90_000;
const PACE_MS = 200;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "photo-insights",
      async () => {
        const posts = await listPhotosToMeasure(WINDOW_DAYS);
        const started = Date.now();
        let measured = 0;
        let failed = 0;
        let skipped = 0;
        let firstError: string | undefined;
        // Instagram insights need the instagram_manage_insights permission, which the page token may not carry. A permission
        // refusal is the same for every post: note it once and stop asking, instead of failing (and logging) every post every day.
        let igDenied: string | undefined;
        for (const p of posts) {
          if (Date.now() - started > BUDGET_MS) {
            skipped++;
            continue;
          }
          try {
            if (p.fbPostId) await savePhotoInsight(p.queueId, "facebook", p.fbPostId, await fetchFacebookPhotoInsights(p.fbPostId, p.brand));
            measured++;
          } catch (err) {
            failed++;
            firstError ??= err instanceof Error ? err.message : String(err);
          }
          // Instagram is independent: a Facebook failure must not hide the Instagram numbers, nor the other way round.
          try {
            if (p.igPostId && !igDenied) await savePhotoInsight(p.queueId, "instagram", p.igPostId, await fetchInstagramPhotoInsights(p.igPostId, p.brand));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/permission|\(#10\)|\(#200\)/i.test(msg)) igDenied = msg;
            else {
              failed++;
              firstError ??= msg;
            }
          }
          await new Promise((res) => setTimeout(res, PACE_MS));
        }
        return { total: posts.length, measured, failed, skipped, firstError, igDenied };
      },
      (r) =>
        `${r.measured}/${r.total} photos measured${r.failed ? `, ${r.failed} failed (${r.firstError})` : ""}${r.skipped ? `, ${r.skipped} skipped (time budget)` : ""}` +
        `${r.igDenied ? ` · Instagram insights not permitted (${r.igDenied})` : ""}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[CRON] photo-insights failed:", err);
    return NextResponse.json({ success: false, error: "photo-insights failed" }, { status: 500 });
  }
}
