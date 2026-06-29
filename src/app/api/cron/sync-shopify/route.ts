import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { runShopifyPush } from "@/jobs/job1-sync";
import { trackCron } from "@/lib/cron-tracking";



/**
 * Cron handler — Phase 2: apply pending Shopify diffs.
 * Runs 10 minutes after the DB sync to allow it to complete first.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await trackCron("sync-shopify", () => runShopifyPush());
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Shopify push failed:`, err);
    return NextResponse.json({ success: false, error: "Shopify push failed" }, { status: 500 });
  }
}

export const maxDuration = 300;
