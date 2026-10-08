import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { checkGscHealth, syncGsc, type SyncResult } from "@/lib/gsc-sync";
import { setSetting } from "@/lib/database";

/**
 * GET /api/cron/gsc-sync — daily import of Google Search Console performance (pages + queries) into Turso.
 * Re-imports the last 7 days (data is revised for a few days). `?backfill=N` imports the last N days (max 480) once.
 * Not configured (no GSC_* env) → recorded as a skipped run, never an error.
 * After a good sync, checkGscHealth flags what Google's 200 cannot (still no data after the grace window, import stalled): that throws, so
 * the run lands as an `error` in cron_runs (dashboard "Résumé du jour"; Klaviyo delivery to Mat is unreliable, see morning-report).
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
      async () => {
        const r: SyncResult & { pending?: boolean } = await syncGsc({ days });
        if (!r.configured) return r;
        const health = await checkGscHealth();
        await setSetting("gsc_health_last", JSON.stringify({ ...health, checkedAt: new Date().toISOString() }));
        if (!health.ok) throw new Error(health.problems.join(" "));
        return { ...r, pending: health.pending };
      },
      (r) =>
        r.configured
          ? `${r.startDate} → ${r.endDate}: ${r.pageRows} pages, ${r.queryRows} requêtes${r.pending ? " (en attente des premières données Google)" : ""}`
          : `non configuré (${r.missing?.join(", ")})`,
    );
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[CRON] gsc-sync failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "gsc-sync failed" }, { status: 500 });
  }
}
