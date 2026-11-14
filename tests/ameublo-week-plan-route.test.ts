import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getSessionRole: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({ listAmeubloTestVideos: vi.fn(), getOccupiedQueueSlots: vi.fn() }));
vi.mock("@/lib/database", () => db);
const approval = vi.hoisted(() => ({ approveAmeubloVideoAt: vi.fn() }));
vi.mock("@/lib/ameublo-approval", () => approval);

import { GET, POST } from "@/app/api/ameublo/week-plan/route";

const NOW = Date.parse("2026-10-06T04:30:00Z");
const vid = (id: number, o: Record<string, unknown> = {}) => ({
  id, lang: "fr", style: "vitrine", caption: "ok", video_url: `https://blob/${id}.mp4`, series: "S", label: `L${id}`, campaign: null, skus: [],
  verdict: null, qa_verdict: "pass", queue_id: null, queue_status: null, ...o,
});
const post = (body: unknown) => POST(new Request("http://x/api/ameublo/week-plan", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  auth.isAuthenticated.mockReset().mockResolvedValue(true);
  auth.getSessionRole.mockReset().mockResolvedValue("admin");
  db.listAmeubloTestVideos.mockReset().mockResolvedValue([]);
  db.getOccupiedQueueSlots.mockReset().mockResolvedValue([]);
  approval.approveAmeubloVideoAt.mockReset().mockResolvedValue({ success: true, id: 1, queueId: 5, scheduledAt: "x" });
});

describe("GET /api/ameublo/week-plan", () => {
  it("401 without a session, 403 for reviewers", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await GET(new Request("http://x/api/ameublo/week-plan"))).status).toBe(401);
    auth.isAuthenticated.mockResolvedValue(true);
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await GET(new Request("http://x/api/ameublo/week-plan"))).status).toBe(403);
  });

  it("only proposes videos nobody approved, rejected or QA-flagged — and plans without the excluded ones", async () => {
    db.listAmeubloTestVideos.mockResolvedValue([
      vid(1), vid(2, { queue_id: 9, queue_status: "pending" }), vid(3, { verdict: "bad" }), vid(4, { qa_verdict: "fail" }),
      vid(5, { caption: " " }), vid(6, { lang: null }), vid(7), vid(8, { queue_id: 3, queue_status: "cancelled" }),
    ]);
    const j = await (await GET(new Request("http://x/api/ameublo/week-plan?days=7"))).json();
    expect(j.data.entries.map((e: { id: number }) => e.id).sort()).toEqual([1, 7, 8]); // 8 was cancelled → "new" again
    const j2 = await (await GET(new Request("http://x/api/ameublo/week-plan?exclude=1"))).json();
    expect(j2.data.entries.map((e: { id: number }) => e.id)).not.toContain(1);
  });
});

describe("POST /api/ameublo/week-plan", () => {
  it("approves each entry on its slot, and refuses a time that is not on the grid", async () => {
    db.listAmeubloTestVideos.mockResolvedValue([vid(1), vid(2)]);
    const res = await post({ action: "approve_plan", entries: [{ id: 1, at: "2026-10-06 11:45:00" }, { id: 2, at: "2026-10-06 11:46:00" }] });
    const j = await res.json();
    expect(approval.approveAmeubloVideoAt).toHaveBeenCalledTimes(1);
    expect(approval.approveAmeubloVideoAt).toHaveBeenCalledWith(1, "2026-10-06 11:45:00");
    expect(j.data).toMatchObject({ approved: 1, refused: 1 });
  });

  it("403 for reviewers, 400 for a bad body", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await post({ action: "approve_plan", entries: [{ id: 1, at: "x" }] })).status).toBe(403);
    auth.getSessionRole.mockResolvedValue("admin");
    expect((await post({ action: "approve_plan", entries: [] })).status).toBe(400);
    expect((await post({ action: "nope" })).status).toBe(400);
  });
});
