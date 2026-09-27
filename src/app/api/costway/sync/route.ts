import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runCostwaySync } from "@/lib/costway/sync";

/**
 * POST /api/costway/sync — manual "Synchroniser" button on the Costway catalogue page.
 * Same work as the daily cron (catalogue only, never Shopify). Session-protected by
 * src/proxy.ts. Body `{ dryRun: true }` diffs without writing.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let dryRun = false;
  try {
    const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown };
    dryRun = body.dryRun === true;
    const data = await trackCron("costway-sync", () => runCostwaySync({ dryRun }));
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[API] /api/costway/sync failed (dryRun=${dryRun}):`, err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
