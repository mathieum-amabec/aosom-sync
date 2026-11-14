import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { syncImageStyles } from "@/lib/image-style-sync";

/**
 * GET /api/cron/image-styles — classifies every new product photo as lifestyle or studio
 * (pixel heuristic, zero tokens) into image_styles. The Meta feeds read that cache so catalog
 * ads only ever show lifestyle photos (Mat, 2026-10-30). Every 4 hours, so the day's imports
 * are classified before the hourly Meta fetch drops them for lack of coverage.
 * `?limit=N` caps the downloads of one run. Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const raw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  try {
    const result = await trackCron(
      "image-styles",
      () => syncImageStyles({ limit }),
      (r) => `photos=${r.photos} missing=${r.missing} classified=${r.classified} lifestyle=${r.lifestyle} studio=${r.studio} failed=${r.failed} deferred=${r.deferred}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/image-styles failed:", err);
    return NextResponse.json({ success: false, error: "image-styles failed" }, { status: 500 });
  }
}
