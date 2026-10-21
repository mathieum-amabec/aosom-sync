/**
 * GET /api/dashboard/teasers?days=30 — "bientôt" teaser funnel per feature and entry point (unique visitors: saw the
 * button → clicked → "ça vous aiderait ?" yes/no → left an email). Session-protected; DB-only.
 */
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getTeaserStats } from "@/lib/database";
import { buildFunnel } from "@/lib/teaser";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 30));
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  try {
    const { events, signups } = await getTeaserStats(since);
    return NextResponse.json({ days, funnel: buildFunnel(events, signups) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/dashboard/teasers failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
