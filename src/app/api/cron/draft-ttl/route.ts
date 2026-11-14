import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { expireStaleDrafts } from "@/lib/database";

/**
 * GET /api/cron/draft-ttl — daily TTL for stale unapproved drafts. Auto-rejects status='draft'
 * posts older than their trigger's TTL (DRAFT_TTL_DAYS): a "new product" post is no longer new
 * after a week; editorial and stock-highlight drafts get two weeks (they never expired before
 * 2026-09-25 and piled up on /social). The queue can't drain the backlog faster than it grows.
 * Only touches unapproved drafts, so an approved/queued draft is never affected.
 *
 * Protected by CRON_SECRET (Bearer). Records the run in cron_runs with detail "expired=N"
 * so it shows in the dashboard cron-health view. Runs daily at 10:00 UTC (vercel.json).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DRAFT_TTL_DAYS: Record<string, number> = { new_product: 7, content_template: 14, stock_highlight: 14 };

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const expired = await trackCron(
      "draft-ttl",
      () => expireStaleDrafts(DRAFT_TTL_DAYS),
      (n) => `expired=${n}`,
    );
    return NextResponse.json({ success: true, expired }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/draft-ttl failed:", err);
    return NextResponse.json({ success: false, error: "draft-ttl failed" }, { status: 500 });
  }
}
