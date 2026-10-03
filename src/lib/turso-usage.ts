/**
 * Opt-in Turso rows-read instrumentation (TURSO_USAGE_LOG=1).
 *
 * Turso bills per row READ, and the libsql client exposes no rows_read, so the only place to see
 * it is the raw hrana `/v2/pipeline` JSON the client exchanges. This wraps `fetch` (passed to
 * createClient), reads `rows_read` off each execute result, and logs one line per statement at or
 * above a threshold — "which SQL burns the quota" — plus a running per-process total.
 *
 * Never throws and never alters the response: any parsing problem is swallowed. Off by default.
 */

export interface UsageEntry {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
}

type FetchFn = typeof fetch;

const MIN_LOGGED_ROWS = Number(process.env.TURSO_USAGE_MIN_ROWS) || 1000;
const totals = { statements: 0, rowsRead: 0, rowsWritten: 0 };

export function tursoUsageTotals(): Readonly<typeof totals> {
  return totals;
}

export function resetTursoUsageTotals(): void {
  totals.statements = totals.rowsRead = totals.rowsWritten = 0;
}

/** SQL text of each request of a pipeline body, in order; non-execute requests yield null. */
function requestSqls(body: unknown): Array<string | null> {
  const reqs = (body as { requests?: unknown[] } | null)?.requests;
  if (!Array.isArray(reqs)) return [];
  return reqs.map((r) => {
    const req = r as { type?: string; stmt?: { sql?: string } } | null;
    return req?.type === "execute" && typeof req.stmt?.sql === "string" ? req.stmt.sql : null;
  });
}

/** Pull {sql, rowsRead, rowsWritten} out of a pipeline request/response pair. */
export function extractUsage(reqBody: unknown, resBody: unknown): UsageEntry[] {
  const sqls = requestSqls(reqBody);
  const results = (resBody as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: UsageEntry[] = [];
  results.forEach((r, i) => {
    const res = (r as { response?: { result?: { rows_read?: number; rows_written?: number } } } | null)?.response?.result;
    if (!res || typeof res.rows_read !== "number") return;
    out.push({ sql: sqls[i] ?? "(unknown)", rowsRead: res.rows_read, rowsWritten: Number(res.rows_written) || 0 });
  });
  return out;
}

function record(entries: UsageEntry[], log: (line: string) => void): void {
  for (const e of entries) {
    totals.statements++;
    totals.rowsRead += e.rowsRead;
    totals.rowsWritten += e.rowsWritten;
    if (e.rowsRead >= MIN_LOGGED_ROWS) {
      const sql = e.sql.replace(/\s+/g, " ").trim().slice(0, 200);
      log(`[turso-usage] rows_read=${e.rowsRead} rows_written=${e.rowsWritten} total_read=${totals.rowsRead} sql="${sql}"`);
    }
  }
}

export function withUsageLogging(base: FetchFn, log: (line: string) => void = console.warn): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let reqBody: unknown = null;
    try {
      if (typeof input !== "string" && !(input instanceof URL) && typeof (input as Request).clone === "function") {
        reqBody = JSON.parse(await (input as Request).clone().text());
      } else if (typeof init?.body === "string") {
        reqBody = JSON.parse(init.body);
      }
    } catch { /* not JSON / unreadable: log without SQL */ }
    const res = await base(input as RequestInfo, init);
    try {
      if (res.ok) record(extractUsage(reqBody, await res.clone().json()), log);
    } catch { /* never break a query over logging */ }
    return res;
  }) as FetchFn;
}

export function usageLoggingEnabled(): boolean {
  return process.env.TURSO_USAGE_LOG === "1";
}
