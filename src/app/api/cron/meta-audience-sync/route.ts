import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { ensureCoreRemarketingAudiences } from "@/lib/meta-ads-client";
import { env } from "@/lib/config";

/**
 * GET /api/cron/meta-audience-sync — makes sure the three pixel-based Website
 * Custom Audiences (30j visiteurs, 30j ajouts panier, 14j vues produit) exist on
 * the ad account, and logs their current approximate size.
 *
 * This is NOT a membership sync: a Website Custom Audience's membership is kept
 * continuously up to date by Meta itself from incoming pixel events — there is
 * nothing for us to push. What this cron actually guards against is the audience
 * being missing (deleted by accident, or never created) before a campaign tries
 * to target it. Weekly is plenty; the audience self-updates every hour in between.
 *
 * Protected by CRON_SECRET (Bearer). Records the run in cron_runs.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function adAccountId(): string {
  const a = env.metaAdAccountId || "20658834";
  return a.startsWith("act_") ? a : `act_${a}`;
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "meta-audience-sync",
      () => ensureCoreRemarketingAudiences(adAccountId()),
      (r) =>
        `visitors30d=${r.visitors30d.id}(${r.visitors30d.approximate_count_lower_bound ?? "?"}-${r.visitors30d.approximate_count_upper_bound ?? "?"}) ` +
        `addToCart30d=${r.addToCart30d.id}(${r.addToCart30d.approximate_count_lower_bound ?? "?"}-${r.addToCart30d.approximate_count_upper_bound ?? "?"}) ` +
        `viewContent14d=${r.viewContent14d.id}(${r.viewContent14d.approximate_count_lower_bound ?? "?"}-${r.viewContent14d.approximate_count_upper_bound ?? "?"})`,
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/meta-audience-sync failed:", err);
    return NextResponse.json({ success: false, error: "meta-audience-sync failed" }, { status: 500 });
  }
}
