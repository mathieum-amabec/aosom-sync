import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { trackCron } from "@/lib/cron-tracking";
import { runStaleCatalogDraft } from "@/lib/stale-catalog";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * GET /api/cron/stale-catalog — daily catalog hygiene. Drafts Shopify products that are
 * imported + still in stock (qty>0) but haven't appeared in the Aosom CSV for >30 days
 * (likely discontinued at Aosom → oversell risk). Already draft/archived products are skipped,
 * and products tagged `exclude-stale` are left live (operator opt-out).
 *
 * Protected by CRON_SECRET (Bearer). Shopify writes are rate-limited to 2 req/sec. Records the
 * run in cron_runs with detail "stale=N drafted=X skipped=Y excluded=W failed=Z". Daily 07:30 UTC.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "stale-catalog",
      () => runStaleCatalogDraft(),
      (r) => `stale=${r.stale} drafted=${r.drafted} skipped=${r.skipped} excluded=${r.excluded} failed=${r.failed}`,
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/stale-catalog failed:", err);
    return NextResponse.json({ success: false, error: "stale-catalog failed" }, { status: 500 });
  }
}
