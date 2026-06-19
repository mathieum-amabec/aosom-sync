import crypto from "crypto";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { env } from "@/lib/config";
import { trackCron } from "@/lib/cron-tracking";
import { drainPublisherQueue } from "@/lib/queue-publisher";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  let expected: string;
  try {
    expected = `Bearer ${env.cronSecret}`;
  } catch {
    return false; // CRON_SECRET missing → 401, not 500
  }
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * GET /api/cron/publisher
 *
 * Vercel cron (hourly) — Bearer CRON_SECRET required. Drains up to 5 due items from
 * publication_queue, publishing each to its platform (facebook / instagram / both /
 * shopify_blog) with an atomic claim guarding against double-publish across overlapping
 * cron instances. Records the run in `cron_runs` via trackCron.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await trackCron(
      "publisher",
      () => drainPublisherQueue(),
      // "due" = items the run actually saw this hour (handled + deferred past the time
      // budget), capped at the drain limit. Surfaces the run's effect on the dashboard.
      (r) => `${r.processed + r.deferred} due, ${r.published} published, ${r.failed} failed`,
    );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] publisher drain failed:`, err);
    return NextResponse.json({ success: false, error: "Publisher drain failed" }, { status: 500 });
  }
}

/** Manual trigger — valid session cookie required. */
export async function POST() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await drainPublisherQueue();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] publisher drain failed:`, err);
    return NextResponse.json({ success: false, error: "Publisher drain failed" }, { status: 500 });
  }
}

// IG reel containers can take ~120s to transcode; with up to 5 items + 2s spacing we
// give the run generous headroom (well under Vercel Pro's max).
export const maxDuration = 300;
