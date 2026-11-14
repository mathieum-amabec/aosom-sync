import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getPriceFloorIncidents, countPriceFloorIncidents } from "@/lib/database";

/**
 * GET /api/price-floor-incidents — TASK 3. The unified, durable history of every time a
 * Shopify price was found below the Aosom floor and corrected, across all 5 write paths
 * (import, price-audit, price-reconcile, the daily sync push, the manual force-push
 * script). Session-protected, like the rest of the dashboard API.
 *
 * Exists so "how often does this happen, since when" has a real answer from one place —
 * before this, answering it meant cross-referencing price_history (90-day retention) and
 * sync_logs (7-day retention), reconstructed by hand (see the 842-375V00CG investigation).
 *
 * Returns the most recent incidents (capped, dashboard-sized) plus lifetime and
 * trailing-30-day counts so the panel can show both "recent list" and "how often, overall".
 */
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 50;
const THIRTY_DAYS_SECONDS = 30 * 24 * 3600;

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const [incidents, total, last30Days] = await Promise.all([
      getPriceFloorIncidents(RECENT_LIMIT),
      countPriceFloorIncidents(),
      countPriceFloorIncidents(nowEpoch - THIRTY_DAYS_SECONDS),
    ]);
    return NextResponse.json(
      { incidents, total, last30Days },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/price-floor-incidents failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
