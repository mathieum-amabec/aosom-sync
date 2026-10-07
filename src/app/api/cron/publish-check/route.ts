import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { trackCron } from "@/lib/cron-tracking";
import { setSetting } from "@/lib/database";
import { trackEvent } from "@/lib/klaviyo-client";
import { REPORT_LOCAL_HOUR, localClock } from "@/lib/morning-report";
import { runPublishCheck, type PublishCheckResult } from "@/lib/publish-check";

/**
 * GET /api/cron/publish-check — 06:15 America/Montreal check that the morning slot(s) really went out.
 *
 * READ-ONLY: never publishes or edits a row. A problem is recorded as an `error` run in `cron_runs`
 * (visible on the dashboard "Résumé du jour" and via the MCP `recent_cron_runs` tool), the result is
 * kept in settings `publish_check_last`, and a Klaviyo "Alerte publication" event is fired best-effort.
 * Klaviyo delivery to Mat is NOT reliable (see morning-report), so cron_runs is the source of truth.
 *
 * SCHEDULE — registered at BOTH 10:15 and 11:15 UTC (Vercel crons don't follow DST); only the run where
 * the Montreal wall clock reads 06:xx executes. `?force=1` bypasses that gate (manual check).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LAST_KEY = "publish_check_last";
export const KLAVIYO_ALERT_METRIC = "Alerte publication";

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const now = new Date();
  const clock = localClock(now);
  if (!force && clock.hour !== REPORT_LOCAL_HOUR) {
    return NextResponse.json({ success: true, skipped: "not-06h", montrealHour: clock.hour });
  }

  let result: PublishCheckResult | null = null;
  try {
    await trackCron(
      "publish-check",
      async () => {
        result = await runPublishCheck(now);
        await setSetting(LAST_KEY, JSON.stringify({ date: clock.date, ...result }));
        if (!result.ok) {
          const recipient = env.morningReportEmail;
          if (recipient) {
            await trackEvent(KLAVIYO_ALERT_METRIC, recipient, {
              subject: `⚠️ Publication de 6 h: ${result.problems.length} problème(s)`,
              body: result.problems.join("\n"),
            }).catch(() => undefined);
          }
          throw new Error(`${result.problems.length} problème(s): ${result.problems.join(" | ")}`.slice(0, 900));
        }
        return result;
      },
      (r) => `${r.publishedCount}/${r.dueCount} publiés, aucun problème`,
    );
    return NextResponse.json({ success: true, data: result });
  } catch {
    return NextResponse.json({ success: false, data: result }, { status: 500 });
  }
}

