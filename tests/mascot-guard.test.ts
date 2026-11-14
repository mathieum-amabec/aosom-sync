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

  it("reports overdue pending, stuck publishing and failed slots", () => {
    const r = evaluatePublishCheck([row({ id: 1, status: "pending" }), row({ id: 2, status: "failed", error: "boom" }), row({ id: 3, status: "publishing", scheduledAt: "2026-10-08 09:00:00" })], [], now);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(3);
    expect(r.problems[1]).toContain("boom");
    expect(r).toMatchObject({ failedCount: 1, stuckCount: 1, overdueCount: 1, windowHours: 24 });
  });

  it("gives a row still being published a moment before calling it stuck", () => {
    const r = evaluatePublishCheck([row({ status: "publishing", scheduledAt: "2026-10-08 10:05:00" }), row({ id: 2, status: "pending", scheduledAt: "2026-10-08 10:08:00" })], [], now);
    expect(r.ok).toBe(true);
  });

  it("flags a published row whose Ameublo Instagram half failed", () => {
    const err = "instagram: Instagram Ameublo Direct (create): Only photo or video can be accepted as media type.";
    const r = evaluatePublishCheck([row({ id: 1682, contentId: "semaine:2026-11-01:morning:ameublo", contentType: "social", error: err })], [], now);
    expect(r.ok).toBe(false);
    expect(r.partialCount).toBe(1);
    expect(r.problems[0]).toContain("publié en partie");
    expect(r.problems[0]).toContain("Only photo or video");
  });

  it("ignores the known Furnish Instagram noise, alone or next to a real error", () => {
    const noise = "instagram: INSTAGRAM_FURNISH_ACCOUNT_ID not configured yet";
    expect(evaluatePublishCheck([row({ contentType: "sequential_ad", error: noise })], [], now).ok).toBe(true);
    const failed = evaluatePublishCheck([row({ status: "failed", error: `facebook: Furnish Direct (reel start): Please retry | ${noise}` })], [], now);
    expect(failed.problems[0]).toContain("Please retry");
    expect(failed.problems[0]).not.toContain("INSTAGRAM_FURNISH");
  });

  it("counts due and published rows per content type", () => {
    const r = evaluatePublishCheck([row({ contentType: "social" }), row({ id: 2, contentType: "sequential_ad" }), row({ id: 3, contentType: "sequential_ad", status: "failed" })], [], now);
    expect(r.byType).toEqual({ social: { due: 1, published: 1 }, sequential_ad: { due: 2, published: 1 } });
  });

  it("surfaces Reels the price guard took out of the queue", () => {
    const r = evaluatePublishCheck([], [], now, [{ id: 7, contentId: "reel:1", scheduledAt: "2026-10-09 10:00:00", reason: "830-001 affiche -30 % mais Shopify -12 %" }]);
    expect(r.ok).toBe(false);
    expect(r.priceGuardBlocked).toBe(1);
    expect(r.problems[0]).toContain("garde de prix");
  });

  it("reports a scheduled mascot row", () => {
    const r = evaluatePublishCheck([row({})], [row({ id: 9, status: "pending", contentId: "ameublo:1" })], now);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("mascotte");
  });
});
