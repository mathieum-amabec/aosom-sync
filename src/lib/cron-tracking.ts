import { recordCronRun } from "./database";

/**
 * Wrap a cron's work so its last run (success/error) is recorded in `cron_runs` and
 * surfaced on the dashboard "Résumé du jour" panel. Re-throws so the route's own
 * error handling/HTTP status is unchanged; the recording is best-effort (never throws).
 */
export async function trackCron<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await safeRecord(name, "success");
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
