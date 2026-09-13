import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { IMPORT } from "@/lib/config";

/**
 * Guards the fix for the silent import failure of 2026-09-13.
 *
 * queueForImport() walks products sequentially and every product costs wall-clock
 * time (image downloads + ONE LLM vision call + DB round-trips). Commit 2f24ff3
 * added the vision call without touching maxDuration=60, so every batch over ~11
 * products was killed mid-loop: a 504 to the client and a half-written queue.
 *
 * These tests fail if anyone re-opens that gap.
 */

const ROUTE_PATH = path.join(__dirname, "..", "src", "app", "api", "import", "queue", "route.ts");

describe("import batch sizing", () => {
  it("finishes the largest allowed batch inside the route's own time budget", () => {
    const worstCaseSeconds =
      IMPORT.MAX_SKUS_PER_BATCH * IMPORT.SECONDS_PER_PRODUCT + IMPORT.FIXED_OVERHEAD_S;
    expect(worstCaseSeconds).toBeLessThanOrEqual(IMPORT.ROUTE_MAX_DURATION_S);
  });

  it("keeps a real safety margin, not a just-barely-fits budget", () => {
    const worstCaseSeconds =
      IMPORT.MAX_SKUS_PER_BATCH * IMPORT.SECONDS_PER_PRODUCT + IMPORT.FIXED_OVERHEAD_S;
    const margin = 1 - worstCaseSeconds / IMPORT.ROUTE_MAX_DURATION_S;
    // A product with many images costs more than the average; leave room for it.
    expect(margin).toBeGreaterThanOrEqual(0.2);
  });

  it("would have caught the 2f24ff3 regression (60 s budget, 40-product batch)", () => {
    const budgetBeforeFix = 60;
    const worstCaseSeconds =
      IMPORT.MAX_SKUS_PER_BATCH * IMPORT.SECONDS_PER_PRODUCT + IMPORT.FIXED_OVERHEAD_S;
    expect(worstCaseSeconds).toBeGreaterThan(budgetBeforeFix);
  });

  it("declares maxDuration as a literal matching IMPORT.ROUTE_MAX_DURATION_S", () => {
    const src = fs.readFileSync(ROUTE_PATH, "utf8");
    // Route segment config is read by static analysis at build time: an imported
    // or computed value is silently ignored and the route quietly keeps the
    // platform default. It has to be a literal, and it has to match config.
    const match = src.match(/export const maxDuration = (\d+);/);
    expect(match, "maxDuration must be a plain numeric literal").not.toBeNull();
    expect(Number(match![1])).toBe(IMPORT.ROUTE_MAX_DURATION_S);
  });

  it("enforces the cap from config rather than a hardcoded number", () => {
    const src = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(src).toContain("IMPORT.MAX_SKUS_PER_BATCH");
    expect(src).not.toMatch(/skus\.length > 50\b/);
  });
});
