/**
 * Reduces a content item's `publication_queue` rows into a single display state for the UI.
 * Pure and DB-free so the precedence rule is unit-testable and shared between the API route
 * (server-rendered join) and any future client-side consumer.
 */

export type DraftQueueState = "scheduled" | "publishing" | "published" | "failed" | "none";

export interface QueueRowLike {
  status: "pending" | "publishing" | "published" | "failed" | "cancelled" | "draft";
  scheduledAt: string; // SQLite UTC TEXT
  publishedAt: string | null;
  error: string | null;
}

export interface QueueSummary {
  state: DraftQueueState;
  /** Earliest still-pending slot (SQLite UTC TEXT), or null if nothing is pending. */
  scheduledAt: string | null;
  /** Latest publish timestamp (SQLite UTC TEXT), or null if nothing has published. */
  publishedAt: string | null;
  /** Error message from the most recent failed row, or null. */
  error: string | null;
  counts: { pending: number; publishing: number; published: number; failed: number; cancelled: number; draft: number };
  /** Non-cancelled row count. */
  total: number;
}

const EMPTY_COUNTS = { pending: 0, publishing: 0, published: 0, failed: 0, cancelled: 0, draft: 0 };

/**
 * Precedence when a content item has rows in more than one state (e.g. queued to two
 * platforms, one already published, one still pending): failed > publishing > pending >
 * published > none. A failure needs operator attention more than a partial success needs
 * a checkmark, so it wins even over a row that already published successfully.
 */
export function summarizeQueueRows(rows: QueueRowLike[]): QueueSummary {
  const counts = { ...EMPTY_COUNTS };
  for (const r of rows) counts[r.status]++;
  const total = rows.length - counts.cancelled;

  const pending = rows.filter((r) => r.status === "pending");
  const publishedRows = rows.filter((r) => r.status === "published");
  const failedRows = rows.filter((r) => r.status === "failed");

  const earliestPending = pending.length > 0
    ? pending.reduce((min, r) => (r.scheduledAt < min ? r.scheduledAt : min), pending[0].scheduledAt)
    : null;
  const latestPublished = publishedRows.length > 0
    ? publishedRows.reduce(
        (max, r) => (r.publishedAt && r.publishedAt > (max ?? "") ? r.publishedAt : max),
        publishedRows[0].publishedAt,
      )
    : null;
  const lastError = failedRows.length > 0 ? failedRows[failedRows.length - 1].error : null;

  let state: DraftQueueState = "none";
  if (counts.failed > 0) state = "failed";
  else if (counts.publishing > 0) state = "publishing";
  else if (counts.pending > 0) state = "scheduled";
  else if (counts.published > 0) state = "published";

  return { state, scheduledAt: earliestPending, publishedAt: latestPublished, error: lastError, counts, total };
}

/** The all-cancelled / no-rows summary, returned for content ids absent from a batch lookup. */
export function emptyQueueSummary(): QueueSummary {
  return { state: "none", scheduledAt: null, publishedAt: null, error: null, counts: { ...EMPTY_COUNTS }, total: 0 };
}
