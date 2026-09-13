import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { IMPORT } from "@/lib/config";
import { isOverBatchCap, excessOverBatchCap } from "@/lib/import-error-message";

/**
 * Tasks A and D of the 2026-09-13 import fix.
 *
 * The repo has no React testing stack (no @testing-library, no jsdom env), and
 * adding one for this fix is not worth the dependency. So the cap decisions are
 * tested as pure functions, and the button wiring — which cannot be observed
 * without mounting — is pinned STRUCTURALLY against the source. A structural
 * test is weaker than a behavioural one; it is here because the thing it guards
 * (a missing `disabled`, a deleted re-entry guard) is exactly what silently
 * regressed before, and it is cheap.
 */

const PAGE_PATH = path.join(
  __dirname,
  "..",
  "src",
  "app",
  "(dashboard)",
  "catalog",
  "page.tsx",
);
const source = () => fs.readFileSync(PAGE_PATH, "utf8");

describe("batch cap decisions (task D)", () => {
  it("allows a selection right up to the cap", () => {
    expect(isOverBatchCap(IMPORT.MAX_SKUS_PER_BATCH)).toBe(false);
    expect(excessOverBatchCap(IMPORT.MAX_SKUS_PER_BATCH)).toBe(0);
  });

  it("flags the first selection over the cap", () => {
    expect(isOverBatchCap(IMPORT.MAX_SKUS_PER_BATCH + 1)).toBe(true);
    expect(excessOverBatchCap(IMPORT.MAX_SKUS_PER_BATCH + 1)).toBe(1);
  });

  it("counts the exact overflow for a two-page selection", () => {
    // The catalogue shows 50 per page and the selection accumulates, so
    // "select all" on two pages is 100 — the case that used to 400 silently.
    expect(excessOverBatchCap(100)).toBe(100 - IMPORT.MAX_SKUS_PER_BATCH);
  });

  it("never reports a negative overflow for an empty or small selection", () => {
    expect(excessOverBatchCap(0)).toBe(0);
    expect(excessOverBatchCap(1)).toBe(0);
  });
});

describe("confirm button wiring (task A, structural)", () => {
  it("refuses a second run while one is in flight", () => {
    expect(source()).toMatch(/if \(importing\) return;/);
  });

  it("disables the confirm button and marks it busy while importing", () => {
    const src = source();
    expect(src).toMatch(/disabled=\{importing \|\| overBatchCap\}/);
    expect(src).toMatch(/aria-busy=\{importing\}/);
  });

  it("swaps the label for a progress message instead of staying static", () => {
    expect(source()).toContain('importing ? "Importation en cours…" : "Confirmer"');
  });

  it("blocks submission outright when the selection is over the cap", () => {
    expect(source()).toMatch(/disabled=\{overBatchCap\}/);
  });

  it("keeps the success path from clearing the in-flight flag", () => {
    // setImporting(false) in a `finally` would re-enable the button during the
    // async navigation to /import and let a trailing click through.
    expect(source()).not.toMatch(/\}\s*finally\s*\{\s*setImporting\(false\)/);
  });
});

describe("error handling (task B, structural)", () => {
  it("handles non-2xx instead of leaving `if (res.ok)` open-ended", () => {
    expect(source()).toContain("describeImportFailure(res, skus.length)");
  });

  it("no longer swallows failures in a bare alert()", () => {
    expect(source()).not.toContain('alert("Failed to queue products")');
  });

  it("renders the error to the screen with an alert role", () => {
    const src = source();
    expect(src).toContain("{importError}");
    expect(src).toMatch(/role="alert"/);
  });
});
