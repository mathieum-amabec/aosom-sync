import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { refreshTrendScores } from "@/lib/trend-refresh";

/**
 * GET /api/cron/trend-scores — weekly recompute of the composite trend score that
 * drives the landing page's "Les plus demandés cette semaine" carousel and the
 * popular-subcategory tile grid (see lib/trend-score.ts).
 *
 * TURSO WRITE ONLY — it replaces the `trend_scores` table. It reads Shopify (live
 * smart-collection rules, tile cover photos, EN collection titles) but writes
 * NOTHING there: no product, no collection, no theme asset. That is why it needs
 * no approval gate, unlike the Shopify-mutating crons.
 *
 * Protected by CRON_SECRET (Bearer). Recorded in cron_runs.
 *
 * SCHEDULE — Mondays 07:50 UTC (03:50 America/Montreal), the store's quietest
 * hour. Deliberately AFTER the 06:00/06:30 UTC catalog sync so the 14-day window
 * includes the freshest stock and price movement, and off the :00/:30 marks the
 * other crons crowd (07:30 stale-catalog, 08:00 blog).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "trend-scores",
      () => refreshTrendScores(),
      (r) =>
        `products=${r.productsWritten}/${r.productsScored} collections=${r.collectionsWritten} ` +
        `tiles=${r.tiles.length} window=${r.windowDays}d ${r.durationMs}ms`,
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/trend-scores failed:", err);
    return NextResponse.json({ success: false, error: "trend-scores failed" }, { status: 500 });
  }
}
