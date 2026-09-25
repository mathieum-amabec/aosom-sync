# Morning report (06:00 America/Montreal, 7 days a week)

`GET /api/cron/morning-report` emails Mat a digest each morning. It covers yesterday's
active Meta campaigns, pSEO guides awaiting approval, `/content-formats` videos, dashboard
alerts, and the counts of items waiting on him. It is **read-only**: it never approves,
publishes or schedules anything.

## How it sends

No new email provider. The cron fires one **Klaviyo event** (metric `Rapport matinal`) on
the profile of `MORNING_REPORT_EMAIL`, using the existing `KLAVIYO_API_KEY`. A Klaviyo
metric-triggered flow turns that event into the email, the same pattern as the price-drop
alerts.

Event properties:

| Property | Content |
|---|---|
| `subject` | e.g. `Rapport du matin — vendredi 25 septembre` (+ `(1 section indisponible)` when a source failed) |
| `body_html` | the full rendered report (inline-styled HTML, all data escaped) |
| `body_text` | plain-text version |
| `report_date` | Montreal date, `YYYY-MM-DD` |
| `missing_sections` | titles of sections that couldn't be collected (`[]` when complete) |

### One-time Klaviyo setup (manual — no API creates it)

1. Vercel env: set `MORNING_REPORT_EMAIL` (Mat's address) in Production. `KLAVIYO_API_KEY`
   is already set.
2. Trigger the metric once so Klaviyo knows it: `GET /api/cron/morning-report?force=1`
   with `Authorization: Bearer $CRON_SECRET`.
3. Klaviyo → Flows → Create flow → **Metric trigger: `Rapport matinal`**, then add one Email:
   - Subject: `{{ event.subject }}`
   - Body: a single **Text/HTML block** containing `{{ event.body_html|safe }}`
     (`|safe` renders the HTML instead of escaping it).
   - Smart Sending **OFF**: it would drop a second report sent within 16 h, such as a
     `?force=1` resend.
4. Set the flow **Live**. Check that Mat's profile isn't suppressed. A never-subscribed
   profile still receives flow emails.

## Schedule and daylight saving

Vercel crons are UTC and don't follow DST. The route is registered at **10:00 and 11:00 UTC**
(`vercel.json`) and sends only on the run where Montreal reads 06:xx:

- 10:00 UTC during EDT (mid-March → early November), which is 06:00 Montreal
- 11:00 UTC during EST (early November → mid-March), which is 06:00 Montreal

The other run returns `{ skipped: "not-06h" }`. `settings.morning_report_last_sent` (the
Montreal date) turns a duplicated or retried invocation into a no-op, so Mat never gets two
reports the same day.

## Failure behaviour

- **A source fails** (Meta API down, a query error): that section renders
  "⚠ Section indisponible (reason)", the subject says so, and the email **still goes out**.
- **Klaviyo rejects the event, or `MORNING_REPORT_EMAIL`/`KLAVIYO_API_KEY` is missing:**
  HTTP 500, recorded in `cron_runs` (dashboard "Résumé du jour"). The day is **not** marked
  sent. There's no automatic same-day retry, because only one of the two daily runs falls
  at 06:00. Fix the cause, then resend with `?force=1`.

## Manual use

- `?dryRun=1` renders the report and returns `{subject, html, text}`. Nothing is sent or
  recorded, and the hour gate is ignored.
- `?force=1` sends now, even outside 06:00 or if already sent today.

Meta figures cover the ad account's "yesterday". The account's timezone is
America/Los_Angeles, so the day boundary is 03:00 Montreal.
