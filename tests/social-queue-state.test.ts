import { describe, it, expect } from "vitest";
import { summarizeQueueRows, emptyQueueSummary, type QueueRowLike } from "@/lib/queue-state";

function row(over: Partial<QueueRowLike> = {}): QueueRowLike {
  return {
    status: "pending",
    scheduledAt: "2026-09-20 15:00:00",
    publishedAt: null,
    error: null,
    ...over,
  };
}

describe("summarizeQueueRows", () => {
  it("returns none for an empty row set", () => {
    expect(summarizeQueueRows([])).toEqual(emptyQueueSummary());
  });

  it("returns none when only cancelled rows exist", () => {
    const s = summarizeQueueRows([row({ status: "cancelled" }), row({ status: "cancelled" })]);
    expect(s.state).toBe("none");
    expect(s.total).toBe(0);
  });

  it("reports scheduled for a single pending row, with its slot", () => {
    const s = summarizeQueueRows([row({ status: "pending", scheduledAt: "2026-09-20 15:00:00" })]);
    expect(s.state).toBe("scheduled");
    expect(s.scheduledAt).toBe("2026-09-20 15:00:00");
    expect(s.total).toBe(1);
  });

  it("picks the EARLIEST pending slot across multiple platforms", () => {
    const s = summarizeQueueRows([
      row({ status: "pending", scheduledAt: "2026-09-22 09:00:00" }),
      row({ status: "pending", scheduledAt: "2026-09-20 15:00:00" }),
    ]);
    expect(s.scheduledAt).toBe("2026-09-20 15:00:00");
  });

  it("reports published with the LATEST publishedAt across rows", () => {
    const s = summarizeQueueRows([
      row({ status: "published", publishedAt: "2026-09-18 10:00:00" }),
      row({ status: "published", publishedAt: "2026-09-19 11:00:00" }),
    ]);
    expect(s.state).toBe("published");
    expect(s.publishedAt).toBe("2026-09-19 11:00:00");
  });

  it("reports the most recent error on a failed row", () => {
    const s = summarizeQueueRows([
      row({ status: "failed", error: "first attempt" }),
      row({ status: "failed", error: "second attempt" }),
    ]);
    expect(s.state).toBe("failed");
    expect(s.error).toBe("second attempt");
  });

  it("precedence: failed beats publishing, pending, and published", () => {
    const s = summarizeQueueRows([
      row({ status: "published", publishedAt: "2026-09-18 10:00:00" }),
      row({ status: "pending" }),
      row({ status: "publishing" }),
      row({ status: "failed", error: "boom" }),
    ]);
    expect(s.state).toBe("failed");
  });

  it("precedence: publishing beats pending and published when no failure exists", () => {
    const s = summarizeQueueRows([
      row({ status: "published", publishedAt: "2026-09-18 10:00:00" }),
      row({ status: "pending" }),
      row({ status: "publishing" }),
    ]);
    expect(s.state).toBe("publishing");
  });

  it("precedence: pending beats published when no failure/publishing exists", () => {
    const s = summarizeQueueRows([
      row({ status: "published", publishedAt: "2026-09-18 10:00:00" }),
      row({ status: "pending" }),
    ]);
    expect(s.state).toBe("scheduled");
  });

  it("counts every status bucket, including cancelled and draft", () => {
    const s = summarizeQueueRows([
      row({ status: "pending" }),
      row({ status: "pending" }),
      row({ status: "cancelled" }),
      row({ status: "draft" }),
    ]);
    expect(s.counts).toEqual({ pending: 2, publishing: 0, published: 0, failed: 0, cancelled: 1, draft: 1 });
    // total excludes cancelled
    expect(s.total).toBe(3);
  });

  it("reports partial-publish counts alongside a failed state", () => {
    const s = summarizeQueueRows([
      row({ status: "published", publishedAt: "2026-09-18 10:00:00" }),
      row({ status: "failed", error: "instagram rejected" }),
    ]);
    expect(s.state).toBe("failed");
    expect(s.counts.published).toBe(1);
    expect(s.total).toBe(2);
  });
});
