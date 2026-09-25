import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import {
  runFeedIntegrityAudit,
  persistFeedIntegrityAudit,
  productionFeedIntegrityDeps,
} from "@/lib/feed-integrity-audit";
import { trackCron } from "@/lib/cron-tracking";

/**
 * GET /api/cron/feed-integrity — daily read-only guard on the ad feeds (09:45 UTC, after the
 * sync and the price / catalog audits). Checks every feed item's `?variant=` link and photo
 * against a fresh Shopify read, compares the feed Google actually downloads, opens five real
 * product pages to confirm the theme preselects the advertised variant, and flags a
 * day-over-day volume drop. NEVER writes to Shopify — see lib/feed-integrity-audit.ts.
 *
 * Protected by CRON_SECRET (Bearer). Wrapped in trackCron (cron_runs) and persisted to
 * settings.feed_integrity_audit, which the dashboard "Alertes" panel and the morning report
 * read through guard-status.ts — same pattern as /api/cron/catalog-consistency.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "feed-integrity",
      async () => {
        const r = await runFeedIntegrityAudit(productionFeedIntegrityDeps);
        await persistFeedIntegrityAudit(r);
        return r;
      },
      (r) =>
        `${r.ok ? "ok" : "ALERT"} items=${r.logic.items} multi=${r.logic.multiItems} served=${r.served?.items ?? "n/a"} ` +
        `drift=${r.served?.drifted ?? "n/a"} landing_ok=${r.landing.filter((l) => l.outcome === "ok").length}/${r.landing.length}` +
        (r.ok ? "" : ` — ${r.reasons.join(" | ")}`),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/feed-integrity failed:", err);
    return NextResponse.json({ error: "Feed integrity audit failed" }, { status: 500 });
  }
}
