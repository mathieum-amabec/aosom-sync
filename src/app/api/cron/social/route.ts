import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { generateSocialBatch, SOCIAL_DAILY_BATCH } from "@/jobs/job4-social";
import { trackCron } from "@/lib/cron-tracking";

/**
 * Cron handler — daily social batch generation.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Daily social batch (default 3): first sweep recently-imported then
  // recently-price-dropped products that are now lifestyle-verified (recovering
  // the sync/import events the per-event triggers dropped when the product wasn't
  // verified yet), then top up with random stock highlights. Every post carries a
  // clean Shopify position-1 lifestyle photo, posted raw (no compositing).
  try {
    const results = await trackCron("social", () => generateSocialBatch(SOCIAL_DAILY_BATCH));
    if (results.length === 0) {
      return NextResponse.json({ success: true, data: [], skipped: "no eligible lifestyle-verified product" });
    }
    return NextResponse.json({
      success: true,
      count: results.length,
      draftIds: results.map((r) => r.draftId),
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/social] stock_highlight failed:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const maxDuration = 300;
