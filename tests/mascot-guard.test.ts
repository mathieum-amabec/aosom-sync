import { describe, it, expect } from "vitest";
import { assertNoMascot, carriesMascot, mascotBlockReason, MascotBlockedError } from "@/lib/mascot-guard";
import { approvalBlocker } from "@/lib/ameublo-approval";
import { evaluatePublishCheck, type CheckRow } from "@/lib/publish-check";

describe("mascot guard", () => {
  it("flags every Studio style except emotion", () => {
    for (const style of ["piece", "devine", "top3", "ab", "reaction", "vitrine"]) {
      expect(carriesMascot({ source: "ameublo_studio", style })).toBe(true);
    }
    expect(carriesMascot({ source: "ameublo_studio", style: "emotion" })).toBe(false);
  });

  it("never flags non-Studio rows (real footage, photos, UGC)", () => {
    expect(carriesMascot({ source: "halloween_real", style: "real" })).toBe(false);
    expect(carriesMascot({ style: "ugc_video" })).toBe(false);
    expect(carriesMascot(null)).toBe(false);
  });

  it("lets a row opt out with mascotFree", () => {
    expect(carriesMascot({ source: "ameublo_studio", style: "vitrine", mascotFree: true })).toBe(false);
  });

  it("assertNoMascot throws a mascot_blocked error", () => {
    expect(() => assertNoMascot({ source: "ameublo_studio", style: "devine" })).toThrow(MascotBlockedError);
    expect(() => assertNoMascot({ source: "ameublo_studio", style: "devine" })).toThrow(/mascot_blocked/);
    expect(() => assertNoMascot({ source: "ameublo_studio", style: "emotion" })).not.toThrow();
    expect(mascotBlockReason({ source: "ameublo_studio", style: "emotion" })).toBeNull();
  });

  it("approval refuses a mascot style even with force", () => {
    const v = { lang: "fr", style: "piece", caption: "x", verdict: null, queue_id: null, queue_status: null, qa_verdict: null } as never;
    expect(approvalBlocker(v, true)).toMatch(/mascotte/i);
    expect(approvalBlocker({ ...(v as object), style: "emotion" } as never, true)).toBeNull();
  });
});

describe("publish check", () => {
  const row = (o: Partial<CheckRow>): CheckRow => ({ id: 1, contentId: "c", status: "published", scheduledAt: "2026-10-08 10:00:00", error: null, ...o });
  const now = new Date("2026-10-08T10:15:00Z");

  it("is ok when every due slot is published", () => {
    const r = evaluatePublishCheck([row({}), row({ id: 2 })], [], now);
    expect(r).toMatchObject({ ok: true, dueCount: 2, publishedCount: 2, problems: [] });
  });

  it("reports pending, publishing and failed slots", () => {
    const r = evaluatePublishCheck([row({ id: 1, status: "pending" }), row({ id: 2, status: "failed", error: "boom" }), row({ id: 3, status: "publishing" })], [], now);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(3);
    expect(r.problems[1]).toContain("boom");
  });

  it("reports a scheduled mascot row", () => {
    const r = evaluatePublishCheck([row({})], [row({ id: 9, status: "pending", contentId: "ameublo:1" })], now);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("mascotte");
  });
});
