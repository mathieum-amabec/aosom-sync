import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { triggerStockHighlight } from "@/jobs/job4-social";
import { trackCron } from "@/lib/cron-tracking";

/**
 * Cron handler — daily stock highlight post generation.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Daily stock highlight: pick the first lifestyle-verified product among a random
  // eligible batch and generate a bilingual draft. The post carries a single branded
  // hero composed (by /api/image-preview) from the product's Shopify position-1
  // lifestyle photo. Returns null (skipped) when no eligible product is verified.
  try {
    const result = await trackCron("social", () => triggerStockHighlight());
    if (!result) {
      return NextResponse.json({ success: true, data: null, skipped: "no eligible product for stock highlight" });
    }
    return NextResponse.json({
      success: true,
      draftId: result.draftId,
      photos: result.imageUrls.length,
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/social] stock_highlight failed:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const maxDuration = 200;
