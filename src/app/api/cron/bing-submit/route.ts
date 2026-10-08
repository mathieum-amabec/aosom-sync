import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { submitToBing } from "@/lib/bing-submit";

/**
 * GET /api/cron/bing-submit — daily: send the storefront URLs Bing has not seen (or that changed) to the Bing Webmaster URL Submission API,
 * newest first, within the daily quota Bing reports. Not configured (no BING_WEBMASTER_API_KEY) → recorded as a skipped run, never an error.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const data = await trackCron(
      "bing-submit",
      () => submitToBing(),
      (r) => (r.configured ? `${r.submitted} envoyées à Bing (quota ${r.quota}), ${r.remaining} en attente sur ${r.candidates} pages` : "non configuré (BING_WEBMASTER_API_KEY)"),
    );
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[CRON] bing-submit failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "bing-submit failed" }, { status: 500 });
  }
}
