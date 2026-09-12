/**
 * Circuit breakers for the daily sync.
 *
 * Both guards exist because of the 2026-09-12 incident, where a frozen CSV cache made
 * Phase 1 see zero changes, which left `products.last_seen_at` un-stamped for the whole
 * catalogue, which made Phase 2 read "no product was seen in the feed today" as "Aosom
 * dropped its entire catalogue" and start drafting the live store at 10 products a run.
 * 30 sellable products were unpublished before it was caught.
 *
 * The lesson is not "add a try/catch": every step reported success, because each step
 * *was* successful in isolation. What was missing is a statement of what a plausible
 * result looks like. That is what lives here.
 *
 * Pure functions, no I/O, so the thresholds can be tested directly.
 */

/**
 * A feed smaller than this fraction of the last known-good count is not believable —
 * Aosom's catalogue moves by tens of products a day, not by half. 0.5 is deliberately
 * loose: this guard is here to catch a truncated or frozen feed, not to police churn.
 */
export const FEED_MIN_RATIO = 0.5;

/**
 * The only absolute rule: a feed with no products is never a valid sync input.
 *
 * Deliberately not a bigger round number. A fixed floor near the live catalogue size is
 * what started this incident — csv-precache's `min 8000` against a catalogue that had
 * drifted to 7,962 — so the absolute check here only catches the case that is wrong at
 * any scale, and the ratio below does the real work as soon as there is history to
 * compare against.
 */
export const FEED_MIN_ABSOLUTE = 1;

/**
 * Fraction of the ACTIVE Shopify catalogue that may be archived from a single diff pass.
 * Real removals trickle in at 0-10 a day against ~1,380 active products (<1%); the
 * incident proposed 1,349 (98%). Anything above this is a data problem, not a catalogue
 * change, so it is refused rather than applied.
 */
export const ARCHIVE_MAX_RATIO = 0.05;

/**
 * Archives are never blocked below this count, whatever the ratio says. Keeps the guard
 * from firing on a small or partially-fetched Shopify catalogue, where 5% is a handful
 * of products and a legitimate cleanup would trip it.
 */
export const ARCHIVE_MIN_ABSOLUTE = 20;

export class ImplausibleFeedError extends Error {
  constructor(
    message: string,
    readonly feedCount: number,
    readonly baselineCount: number,
  ) {
    super(message);
    this.name = "ImplausibleFeedError";
  }
}

/**
 * Throw unless today's feed is a believable size next to the last known-good run.
 *
 * Called BEFORE anything is written, so a refusal leaves the previous checkpoint —
 * the last state we know was good — exactly where it is. Phase 1 failing loudly and
 * changing nothing is always better than Phase 1 succeeding on a catalogue it cannot
 * actually see.
 *
 * @param feedCount     products parsed from today's feed
 * @param baselineCount totalProducts from the last good checkpoint; 0/undefined when
 *                      there is no history yet, in which case only the absolute floor applies
 */
export function assertFeedPlausible(feedCount: number, baselineCount?: number): void {
  if (feedCount < FEED_MIN_ABSOLUTE) {
    throw new ImplausibleFeedError(
      `Feed came back empty (${feedCount} products). An empty feed is never a valid sync ` +
        `input — it is indistinguishable from "the supplier withdrew everything", which is ` +
        `how 30 live products got unpublished on 2026-09-12. Refusing to sync — the ` +
        `previous checkpoint is left untouched.`,
      feedCount,
      baselineCount ?? 0,
    );
  }

  if (!baselineCount || baselineCount <= 0) return; // no history to compare against

  const floor = Math.floor(baselineCount * FEED_MIN_RATIO);
  if (feedCount < floor) {
    throw new ImplausibleFeedError(
      `Feed has ${feedCount} products, under ${Math.round(FEED_MIN_RATIO * 100)}% of the ` +
        `last good run's ${baselineCount} (floor ${floor}). Refusing to sync — the previous ` +
        `checkpoint is left untouched.`,
      feedCount,
      baselineCount,
    );
  }
}

export interface ArchiveGuardResult<T> {
  /** Diffs cleared to run. Non-archive diffs are always here, whatever the verdict. */
  allowed: T[];
  /** Archive diffs held back. Empty when the guard did not fire. */
  blocked: T[];
  /** True when the archive volume crossed the threshold and archives were held back. */
  tripped: boolean;
  /** Human-readable reason, for the log line and the operator notification. */
  reason: string | null;
  /** Ceiling that applied to this pass, for observability. */
  threshold: number;
}

/**
 * Hold back a mass-archive pass while letting everything else through.
 *
 * The split matters: the 2026-09-12 failure mode poisons exactly one kind of diff —
 * "this product is gone from the feed" — and leaves price, stock, image and tag diffs
 * perfectly valid. Blocking the whole run would mean a day of stale prices on the
 * storefront as the cost of avoiding a bad archive, which is a trade nobody asked for.
 * So archives are dropped and the rest of the run proceeds.
 *
 * @param diffs             every diff computed for this pass
 * @param activeShopifyCount number of ACTIVE products in Shopify — the denominator
 * @param isArchive         predicate identifying an archive diff
 */
export function guardMassArchive<T>(
  diffs: T[],
  activeShopifyCount: number,
  isArchive: (d: T) => boolean,
): ArchiveGuardResult<T> {
  const archives = diffs.filter(isArchive);
  const threshold = Math.max(ARCHIVE_MIN_ABSOLUTE, Math.floor(activeShopifyCount * ARCHIVE_MAX_RATIO));

  if (archives.length <= threshold) {
    return { allowed: diffs, blocked: [], tripped: false, reason: null, threshold };
  }

  const pct = activeShopifyCount > 0 ? ((archives.length / activeShopifyCount) * 100).toFixed(1) : "n/a";
  return {
    allowed: diffs.filter((d) => !isArchive(d)),
    blocked: archives,
    tripped: true,
    threshold,
    reason:
      `${archives.length} archives proposed for ${activeShopifyCount} active products (${pct}%), ` +
      `over the ceiling of ${threshold}. Archives are BLOCKED for this run; every other diff ` +
      `(price, stock, images, tags) still applies. This almost always means the Aosom feed was ` +
      `empty or stale when the diff ran, not that the catalogue was withdrawn.`,
  };
}
