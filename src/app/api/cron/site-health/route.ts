import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { runSiteHealth, persistSiteHealth, productionSiteHealthDeps, funnelLine } from "@/lib/site-health";
import { trackCron } from "@/lib/cron-tracking";

/**
 * GET /api/cron/site-health — daily read-only check of the storefront (10:30 UTC): broken pages
 * and links, Liquid errors, missing Google descriptions, H1 count, promo codes in the live
 * Klaviyo emails that no longer work in Shopify, zero-result searches, and a 7-day funnel.
 * NEVER writes to Shopify or Klaviyo — see lib/site-health.ts.
 *
 * Protected by CRON_SECRET (Bearer). Wrapped in trackCron (cron_runs) and persisted to
 * settings.site_health_audit, which the dashboard "Alertes" panel and the morning report read
 * through guard-status.ts — same pattern as /api/cron/feed-integrity.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "site-health",
      async () => {
        const r = await runSiteHealth(productionSiteHealthDeps);
        await persistSiteHealth(r);
        return r;
      },
      (r) =>
        `${r.ok ? "ok" : "ALERT"} pages=${r.pages.checked} codes=${r.promoCodes?.checked.length ?? "n/a"} ` +
        `recherches=${r.searches?.tested ?? "n/a"} sans_resultat=${r.searches?.zeroResults.length ?? "n/a"} — ${funnelLine(r.funnel)}` +
        (r.ok ? "" : ` — ${r.reasons.join(" | ")}`),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/site-health failed:", err);
    return NextResponse.json({ error: "Site health check failed" }, { status: 500 });
  }
}
