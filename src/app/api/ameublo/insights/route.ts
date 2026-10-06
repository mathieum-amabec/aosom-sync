import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getReelResultRows } from "@/lib/database";
import { summarizeReels } from "@/lib/reel-insights";

/**
 * Studio Ameublo — "Résultats": how the published Reels perform.
 *
 * GET ?days=14 → { summary, rows }: every measured Reel of the last `days` days (default 14, max 60) and the tables built from
 * them (by kind of video, language and time slot, each with its sample size). Read-only; the numbers come from the daily
 * /api/cron/reel-insights snapshot, so they are at most a day old.
 */
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const days = Math.min(60, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 14));
  const rows = await getReelResultRows(days);
  return NextResponse.json({ success: true, data: { days, summary: summarizeReels(rows), rows } }, { headers: { "Cache-Control": "no-store" } });
}
