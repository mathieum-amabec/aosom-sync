import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { syncGsc } from "@/lib/gsc-sync";

/**
 * GET /api/cron/gsc-sync — daily import of Google Search Console performance (pages + queries) into Turso.
 * Re-imports the last 7 days (data is revised for a few days). `?backfill=N` imports the last N days (max 480) once.
 * Not configured (no GSC_* env) → recorded as a skipped run, never an error.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const backfill = Number(new URL(request.url).searchParams.get("backfill"));
  const days = Number.isFinite(backfill) && backfill > 0 ? Math.min(backfill, 480) : 7;
  try {
    const data = await trackCron(
      "gsc-sync",
      () => syncGsc({ days }),
      (r) => (r.configured ? `${r.startDate} → ${r.endDate}: ${r.pageRows} pages, ${r.queryRows} requêtes` : `non configuré (${r.missing?.join(", ")})`),
    );
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[CRON] gsc-sync failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "gsc-sync failed" }, { status: 500 });
  }
}
