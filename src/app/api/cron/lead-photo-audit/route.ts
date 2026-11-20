import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { runLeadPhotoAudit, persistLeadPhotoAudit } from "@/lib/lead-photo-audit";
import { trackCron } from "@/lib/cron-tracking";

/**
 * GET /api/cron/lead-photo-audit — daily read-only guard on the lead photo of live products (09:50 UTC, after the
 * 4-hourly `image-styles` run has classified the day's imports). Reads the `image_styles` cache only: 0 token, never
 * writes to Shopify. Red when a product imported in the last 14 days opens on a studio packshot although a lifestyle
 * photo is in its gallery — see lib/lead-photo-audit.ts. Persists settings.lead_photo_audit, read by guard-status.ts.
 *
 * Protected by CRON_SECRET (Bearer). Wrapped in trackCron (cron_runs).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "lead-photo-audit",
      async () => {
        const r = await runLeadPhotoAudit();
        await persistLeadPhotoAudit(r);
        return r;
      },
      (r) =>
        `${r.ok ? "ok" : "ALERT"} products=${r.products} lead_lifestyle=${r.galleryLead.lifestyle} lead_studio=${r.galleryLead.studio} ` +
        `unknown=${r.galleryLead.unknown} fixable=${r.fixable} new_fixable=${r.newFixable}` + (r.ok ? "" : ` — ${r.reasons.join(" | ")}`),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/lead-photo-audit failed:", err);
    return NextResponse.json({ error: "Lead photo audit failed" }, { status: 500 });
  }
}
