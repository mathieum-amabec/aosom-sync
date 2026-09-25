import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { trackCron } from "@/lib/cron-tracking";
import { getSetting, setSetting } from "@/lib/database";
import { trackEvent } from "@/lib/klaviyo-client";
import {
  REPORT_LOCAL_HOUR,
  collectMorningReport,
  localClock,
  renderMorningReport,
} from "@/lib/morning-report";
import { morningReportSources as sources } from "@/lib/morning-report-sources";

/**
 * GET /api/cron/morning-report — Mat's daily 06:00 America/Montreal email digest.
 *
 * READ-ONLY + INFORMATIONAL: it reads Turso and Meta insights, then fires ONE Klaviyo event
 * ("Rapport matinal") on MORNING_REPORT_EMAIL's profile. A Klaviyo metric-triggered flow turns
 * that event into the email (body = `{{ event.body_html|safe }}`, subject = `{{ event.subject }}`).
 * It never approves, publishes or schedules anything.
 *
 * SCHEDULE — Vercel crons are UTC and don't follow DST, so it's registered at BOTH 10:00 and
 * 11:00 UTC and only the run where the Montreal wall clock reads 06:xx sends: 10:00 UTC during
 * EDT (summer), 11:00 UTC during EST (winter). The other run returns `skipped: "not-06h"`.
 * `settings.morning_report_last_sent` (Montreal date) makes a retried/duplicated invocation a
 * no-op, so Mat never gets two reports the same day.
 *
 * Query: `?dryRun=1` renders and returns the report without sending or recording anything;
 * `?force=1` bypasses the 06:00 gate and the once-a-day guard (manual resend).
 *
 * Partial failure: each section is collected independently — if Meta (or any source) is down,
 * the email still goes out with that section marked "indisponible" and flagged in the subject.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const LAST_SENT_KEY = "morning_report_last_sent";
export const KLAVIYO_METRIC = "Rapport matinal";


export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const force = url.searchParams.get("force") === "1";
  const now = new Date();
  const clock = localClock(now);

  if (dryRun) {
    const report = renderMorningReport(await collectMorningReport(sources, now));
    return NextResponse.json({ success: true, dryRun: true, ...report }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!force && clock.hour !== REPORT_LOCAL_HOUR) {
    return NextResponse.json({ success: true, skipped: "not-06h", montrealHour: clock.hour });
  }

  try {
    const result = await trackCron(
      "morning-report",
      async () => {
        if (!force && (await getSetting(LAST_SENT_KEY)) === clock.date) {
          return { skipped: "already-sent" as const, date: clock.date };
        }
        const recipient = env.morningReportEmail;
        if (!recipient) throw new Error("MORNING_REPORT_EMAIL non configuré — rapport non envoyé");

        const report = renderMorningReport(await collectMorningReport(sources, now));
        const sent = await trackEvent(KLAVIYO_METRIC, recipient, {
          subject: report.subject,
          body_html: report.html,
          body_text: report.text,
          report_date: clock.date,
          missing_sections: report.missingSections,
        });
        if (!sent.ok) {
          throw new Error(`envoi Klaviyo échoué: ${sent.skipped ? "KLAVIYO_API_KEY absente" : sent.error ?? "inconnu"}`);
        }
        await setSetting(LAST_SENT_KEY, clock.date);
        return { sent: true as const, date: clock.date, missingSections: report.missingSections };
      },
      (r) =>
        "skipped" in r
          ? `skipped: already sent for ${r.date}`
          : `sent for ${r.date}${r.missingSections.length ? ` — missing: ${r.missingSections.join(", ")}` : ""}`,
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/morning-report failed:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "morning-report failed" },
      { status: 500 },
    );
  }
}
