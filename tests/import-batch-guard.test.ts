/**
 * Batch-level circuit breaker for the import bulk push (import/page.tsx's
 * startBulk). Deliberately its own module/test file, with zero imports: this
 * is called from a "use client" component, and import-quality-gates.ts (where
 * this used to live) transitively pulls in database.ts/shopify-client.ts/
 * vision-classifier.ts (server-only) — importing it from the client broke
 * `next build` (PR #498's first preview deploy: ENOENT during the build step,
 * libsql's native binding resolution failing against a browser target).
 */
import { describe, it, expect } from "vitest";
import {
  shouldTripCircuitBreaker,
  CIRCUIT_BREAKER_MIN_SAMPLE,
  CIRCUIT_BREAKER_THRESHOLD,
} from "@/lib/import-batch-guard";

describe("shouldTripCircuitBreaker", () => {
  it("never trips below the minimum sample, even at 100% failure", () => {
    expect(
      shouldTripCircuitBreaker({ errors: 3, needsReview: 0, processed: CIRCUIT_BREAKER_MIN_SAMPLE - 1 }),
    ).toBe(false);
  });

  it("does not trip at the minimum sample when the failure rate is under threshold", () => {
    // 1/10 = 10%, under the 15% threshold.
    expect(
      shouldTripCircuitBreaker({ errors: 1, needsReview: 0, processed: CIRCUIT_BREAKER_MIN_SAMPLE }),
    ).toBe(false);
  });

  it("does not trip exactly AT the threshold (strictly greater-than, not >=)", () => {
    // 15/100 = exactly 15% — the threshold itself must still be allowed through.
    expect(shouldTripCircuitBreaker({ errors: 15, needsReview: 0, processed: 100 })).toBe(false);
  });

  it("trips once the failure rate exceeds the threshold, past the minimum sample", () => {
    // 2/10 = 20%, over the 15% threshold, at exactly the minimum sample.
    expect(
      shouldTripCircuitBreaker({ errors: 2, needsReview: 0, processed: CIRCUIT_BREAKER_MIN_SAMPLE }),
    ).toBe(true);
  });

  it("counts errors and needs_review together toward the failure rate", () => {
    // 1 hard error + 1 quality flag = 2/10 = 20%, over threshold.
    expect(
      shouldTripCircuitBreaker({ errors: 1, needsReview: 1, processed: CIRCUIT_BREAKER_MIN_SAMPLE }),
    ).toBe(true);
  });

  it("exact threshold value matches CIRCUIT_BREAKER_THRESHOLD (documents the constant, not a magic number)", () => {
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(0.15);
    expect(CIRCUIT_BREAKER_MIN_SAMPLE).toBe(10);
  });
});
