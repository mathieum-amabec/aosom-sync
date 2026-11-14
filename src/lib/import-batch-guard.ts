/**
 * Circuit breaker for a bulk import batch (import/page.tsx's startBulk). Split
 * out from import-quality-gates.ts on purpose: that module (transitively, via
 * enforceCleanPrimaryImage) pulls in database.ts, shopify-client.ts, and
 * vision-classifier.ts — all server-only (DB client, secrets, fetch to
 * external APIs). import/page.tsx is a "use client" component; importing
 * anything from that module graph into it drags the whole server-only chain
 * into the client bundle, which fails to build (confirmed: PR #498's first
 * preview deploy broke `next build` with an ENOENT during the build step —
 * libsql's native binding resolution failing against a browser target). This
 * file has zero imports, so it's safe for either side.
 *
 * Pulled out as a pure function so it's testable without a browser/DOM: the
 * batch loop only calls it, never re-implements the arithmetic.
 *
 * MIN_SAMPLE guards against tripping on noise in a small batch (1 failure in 3
 * items is 33%, way over threshold, but tells you nothing about a systemic
 * problem). THRESHOLD's failure count is errors + needs_review combined — a
 * systemic bug shows up as either, and the point is to stop feeding it more
 * products either way.
 */
export const CIRCUIT_BREAKER_MIN_SAMPLE = 10;
export const CIRCUIT_BREAKER_THRESHOLD = 0.15;

export function shouldTripCircuitBreaker(counts: {
  errors: number;
  needsReview: number;
  processed: number;
}): boolean {
  if (counts.processed < CIRCUIT_BREAKER_MIN_SAMPLE) return false;
  return (counts.errors + counts.needsReview) / counts.processed > CIRCUIT_BREAKER_THRESHOLD;
}
