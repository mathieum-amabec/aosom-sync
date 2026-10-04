import { describe, it, expect } from "vitest";
import { markScheduled, markUnscheduled } from "@/lib/ameublo-studio-state";

const v = (id: number) => ({ id, queue_id: null as number | null, queue_status: null as string | null, queue_scheduled_at: null as string | null });

describe("ameublo studio local state", () => {
  it("marks only the approved video as pending in the queue", () => {
    const out = markScheduled([v(1), v(2)], 2, 99, "2026-10-05 14:00:00");
    expect(out[0]).toEqual(v(1));
    expect(out[1]).toMatchObject({ id: 2, queue_id: 99, queue_status: "pending", queue_scheduled_at: "2026-10-05 14:00:00" });
  });
  it("round-trips back to unscheduled", () => {
    const out = markUnscheduled(markScheduled([v(1)], 1, 5, "2026-10-05 14:00:00"), 1);
    expect(out[0]).toEqual(v(1));
  });
});
