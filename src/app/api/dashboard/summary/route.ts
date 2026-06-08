import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDashboardSummary } from "@/lib/database";

/**
 * GET /api/dashboard/summary — "Résumé du jour" panel.
 * Session-protected. Returns DB-only metrics (fast): new products imported today,
 * social drafts generated this week, active (confirmed) price alerts, and each cron's
 * last run. Estimated Meta-Ads revenue is merged client-side from /api/ads/insights so
 * this route never blocks on the Graph API.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const summary = await getDashboardSummary();
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/dashboard/summary failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
