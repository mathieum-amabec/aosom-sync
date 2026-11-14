/**
 * The last morning report, kept in `settings` so it can be READ anywhere (the MCP tool `morning_report`, the dashboard) without
 * going through an email provider. The 06:00 cron stores it BEFORE it tries Klaviyo, so a failing or silent email never makes
 * the report itself disappear. Tiny on purpose (text only): the MCP server may only run a SELECT on this key.
 */
export const MORNING_REPORT_LAST_KEY = "morning_report_last";

export interface StoredReport {
  /** Montreal calendar date the report is for (YYYY-MM-DD). */
  date: string;
  subject: string;
  /** Plain-text version of the whole report. */
  text: string;
  missingSections: string[];
  /** ISO time the report was built. */
  generatedAt: string;
}

export function serializeReport(r: StoredReport): string {
  return JSON.stringify(r);
}

/** Tolerant reader: a missing or malformed value is "no report yet", never an exception. */
export function parseStoredReport(raw: unknown): StoredReport | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<StoredReport>;
    if (typeof j.date !== "string" || typeof j.text !== "string") return null;
    return {
      date: j.date,
      subject: typeof j.subject === "string" ? j.subject : "",
      text: j.text,
      missingSections: Array.isArray(j.missingSections) ? j.missingSections.map(String) : [],
      generatedAt: typeof j.generatedAt === "string" ? j.generatedAt : "",
    };
  } catch {
    return null;
  }
}
