import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { trackCron } from "@/lib/cron-tracking";
import { drainPublisherQueue, type DrainResult } from "@/lib/queue-publisher";
import { isPublisherPaused } from "@/lib/automation-controls";

const PAUSED_RESULT: DrainResult & { paused: true } = {
  processed: 0, published: 0, failed: 0, skipped: 0, deferred: 0, reclaimed: 0, outcomes: [], paused: true,
};

/**
 * GET /api/cron/publisher
 *
 * Vercel cron (every 5 minutes, so a slot goes out within 5 min of its time) — Bearer CRON_SECRET
 * required. Drains up to 5 due items from
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
      // Operator switch ("Automatisations" page): while paused, nothing leaves the queue — rows stay
      // `pending`, nothing is lost, and the next tick after the switch is turned back on drains them.
      async () => ((await isPublisherPaused()) ? { ...PAUSED_RESULT } : drainPublisherQueue()),
      // "due" = items the run actually saw this hour (handled + deferred past the time
      // budget), capped at the drain limit. Surfaces the run's effect on the dashboard.
      (r) =>
        "paused" in r && r.paused
          ? "EN PAUSE — publications automatiques arrêtées (interrupteur)"
          : `${r.processed + r.deferred} due, ${r.published} published, ${r.failed} failed`,
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
