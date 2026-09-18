import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { runUgcVideoReinjection } from "@/jobs/job4-social";
import { trackCron } from "@/lib/cron-tracking";

/**
 * Cron handler — weekly UGC video reinjection (Part B Task 6, 2026-09-18 strategic
 * investigation). SEMI-automated: generates up to 3 new facebook_drafts (status
 * 'draft') from unused customer unboxing videos, exactly like the daily social
 * batch — publication still requires manual approval in /social. Protected by
 * CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const results = await trackCron("ugc-reinjection", () => runUgcVideoReinjection(3));
    if (results.length === 0) {
      return NextResponse.json({ success: true, data: [], skipped: "no unused UGC video candidates" });
    }
    return NextResponse.json({
      success: true,
      count: results.length,
      draftIds: results.map((r) => r.draftId),
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/ugc-reinjection] failed:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const maxDuration = 120;
