import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { runCatalogConsistencyAudit, persistCatalogConsistencyAudit } from "@/lib/catalog-consistency-audit";
import { trackCron } from "@/lib/cron-tracking";

/**
 * GET /api/cron/catalog-consistency — daily read-only audit for the three catalog
 * content defects found in the 2026-09 investigation: English body_html, a leaked
 * supplier brand name, and duplicate EN/FR "Couleur" option values. NEVER writes to
 * Shopify — this is the drift tripwire, not the fix. The fixes live at the point
 * content is generated (content-generator.ts) and where color is derived
 * (variant-merger.ts's translateColor).
 *
 * Protected by CRON_SECRET (Bearer). Wrapped in trackCron so a run lands in
 * `cron_runs` like the other crons (dashboard cron-health view) and persists a
 * compact summary to `settings` (catalog_consistency_audit) for the dashboard to
 * show without re-running the Shopify sweep.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "catalog-consistency",
      async () => {
        const r = await runCatalogConsistencyAudit();
        await persistCatalogConsistencyAudit(r);
        return r;
      },
      (r) =>
        `active=${r.totalActive} english=${r.englishDescriptions} brand_leaks=${r.brandLeaks} duplicate_color=${r.duplicateColorOptions}`,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/catalog-consistency failed:", err);
    return NextResponse.json({ error: "Catalog consistency audit failed" }, { status: 500 });
  }
}
