import { recordCronRun } from "./database";

/**
 * Wrap a cron's work so its last run (success/error) is recorded in `cron_runs` and
 * surfaced on the dashboard "Résumé du jour" panel. Re-throws so the route's own
 * error handling/HTTP status is unchanged; the recording is best-effort (never throws).
 *
 * Pass `summarize` to record a one-line `detail` on success (e.g. "3 due, 2 published,
 * 0 failed") so the dashboard shows what the run did, not just that it ran. It runs after
 * `fn` resolves and is best-effort: a throw inside it is swallowed (detail omitted), never
 * turning a run that already succeeded into a failure. The error path always records the
 * thrown message.
 */
export async function trackCron<T>(
  name: string,
  fn: () => Promise<T>,
  summarize?: (result: T) => string | undefined,
): Promise<T> {
  try {
    const result = await fn();
    let detail: string | undefined;
    try {
      detail = summarize?.(result);
    } catch (summarizeErr) {
      // A summarizer bug must not fail a run whose work already succeeded — just drop the
      // detail (same best-effort posture as safeRecord's own write failures).
      console.error(`[trackCron] summarize threw for "${name}":`, summarizeErr);
    }
    await safeRecord(name, "success", detail);
    return result;
  } catch (err) {
    await safeRecord(name, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Record the cron outcome without ever throwing. A telemetry write failure (DB
 * down, schema not migrated) must not turn a successful cron run into a 500 or
 * mask the original error on the failure path — the dashboard row is best-effort.
 */
async function safeRecord(name: string, status: "success" | "error", detail?: string): Promise<void> {
  try {
    await recordCronRun(name, status, detail);
  } catch (recordErr) {
    console.error(`[trackCron] failed to record ${status} for "${name}":`, recordErr);
  }
}
