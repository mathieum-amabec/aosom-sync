import { describe, it, expect, vi, beforeEach } from "vitest";

// recordCronRun is the only @/lib/database dependency trackCron pulls in.
vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { trackCron } from "@/lib/cron-tracking";
import { recordCronRun } from "@/lib/database";

const rec = vi.mocked(recordCronRun);

describe("trackCron", () => {
  beforeEach(() => rec.mockReset().mockResolvedValue(undefined));

  it("returns the fn result and records success", async () => {
    const result = await trackCron("blog", async () => 42);
    expect(result).toBe(42);
    expect(rec).toHaveBeenCalledWith("blog", "success", undefined);
  });

  it("re-throws the fn error and records error with the message", async () => {
    await expect(trackCron("content", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(rec).toHaveBeenCalledWith("content", "error", "boom");
  });

  it("stringifies a non-Error throw for the recorded detail", async () => {
    await expect(trackCron("csv-precache", async () => { throw "weird"; })).rejects.toBe("weird");
    expect(rec).toHaveBeenCalledWith("csv-precache", "error", "weird");
  });

  it("records the summarize() output as the success detail", async () => {
    const result = await trackCron(
      "publisher",
      async () => ({ processed: 3, deferred: 1, published: 2, failed: 1 }),
      (r) => `${r.processed + r.deferred} due, ${r.published} published, ${r.failed} failed`,
    );
    expect(result).toEqual({ processed: 3, deferred: 1, published: 2, failed: 1 });
    expect(rec).toHaveBeenCalledWith("publisher", "success", "4 due, 2 published, 1 failed");
  });

  it("swallows a summarize() throw and still records success without detail", async () => {
    const result = await trackCron("publisher", async () => 7, () => { throw new Error("fmt bug"); });
    expect(result).toBe(7);
    expect(rec).toHaveBeenCalledWith("publisher", "success", undefined);
  });

  // Best-effort recording (a recordCronRun failure must not fail the cron run, nor
  // mask the original error) is covered end-to-end by the route tests: cron-content
  // and csv-precache partial-mock @/lib/database WITHOUT recordCronRun, so the call
  // throws and safeRecord swallows it — those routes still return their normal
  // success/500 responses. Asserting it again here with a throwing spy trips
  // vitest's unhandled-rejection tracker even though safeRecord catches it.
});
