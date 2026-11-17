/**
 * GET /api/dashboard/visitors?days=30&country=CA — first visit vs return (src/lib/visitor-tracking.ts): visits and
 * unique visitors, how many came back, and how often each visit number adds to the cart / heads to checkout, split by
 * site (ameublodirect.ca / furnishdirect.ca). country=all keeps every country. Session-protected; DB-only.
 */
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getVisitorSessions } from "@/lib/database";
import { buildVisitorReport } from "@/lib/visitor-tracking";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const days = Math.min(365, Math.max(1, Number(params.get("days")) || 30));
  const c = (params.get("country") || "CA").toUpperCase();
  const country = c === "ALL" ? null : /^[A-Z]{2}$/.test(c) ? c : "CA";
  try {
    const rows = await getVisitorSessions(Math.floor(Date.now() / 1000) - days * 86_400, country);
    return NextResponse.json({ days, country: country ?? "all", ...buildVisitorReport(rows) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/dashboard/visitors failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
