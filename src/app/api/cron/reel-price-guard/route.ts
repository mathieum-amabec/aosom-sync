import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runReelPriceGuard } from "@/lib/reel-price-guard";

/**
 * GET /api/cron/reel-price-guard — 12:00 and 20:00 UTC. Re-checks on Shopify the rabais burned into
 * every pending sequential_ad Reel due in the next 36 h (`metadata.badges`) and moves a Reel whose
 * discount no longer matches the store to `draft` (not published, slot freed). See
 * lib/reel-price-guard.ts. Shopify is only READ.
 *   ?dryRun=1  report what would be blocked; writes nothing (no row, no setting).
 * Protected by CRON_SECRET.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const run = () => runReelPriceGuard({ dryRun });
    const result = dryRun
      ? await run()
      : await trackCron("reel-price-guard", run, (r) =>
          `${r.checked} Reel(s) avec rabais vérifiés · ${r.ok} OK · ${r.blocked.length} retiré(s)${r.unverified.length ? ` · ${r.unverified.length} non vérifiable(s)` : ""}`,
        );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/reel-price-guard] failed:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
