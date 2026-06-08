import { recordCronRun } from "./database";

/**
 * Wrap a cron's work so its last run (success/error) is recorded in `cron_runs` and
 * surfaced on the dashboard "Résumé du jour" panel. Re-throws so the route's own
 * error handling/HTTP status is unchanged; the recording is best-effort (never throws).
 */
export async function trackCron<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await recordCronRun(name, "success");
    return result;
  } catch (err) {
    await recordCronRun(name, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
