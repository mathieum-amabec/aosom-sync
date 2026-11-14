import { NextResponse } from "next/server";
import { isAuthenticated, isAdmin } from "@/lib/auth";
import { readGscConfig } from "@/lib/gsc-client";
import { getSeoSummary } from "@/lib/gsc-sync";
import { getSetting } from "@/lib/database";

/**
 * GET /api/seo/summary?days=28 — Google Search Console performance (clicks, impressions, CTR, position, by section,
 * top pages and queries) from the daily import. Admin only. When the service account is not configured it returns
 * `{ configured: false, missing: [...] }` so the page can show the setup steps instead of an error.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!(await isAdmin())) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const cfg = readGscConfig();
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 28, 7), 90);
  try {
    const summary = await getSeoSummary(days);
    const rawHealth = cfg.configured ? await getSetting("gsc_health_last") : null;
    const health = rawHealth ? (JSON.parse(rawHealth) as unknown) : null;
    return NextResponse.json(
      { success: true, data: { configured: cfg.configured, missing: cfg.configured ? [] : cfg.missing, health, summary } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/seo/summary failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
