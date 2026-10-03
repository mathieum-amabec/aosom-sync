import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getSessionRole: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({ listAmeubloTestVideos: vi.fn(), setAmeubloTestVerdict: vi.fn() }));
vi.mock("@/lib/database", () => db);

import { GET, PATCH } from "@/app/api/ameublo/videos/route";

const patch = (body: unknown) =>
  PATCH(new Request("http://x/api/ameublo/videos", { method: "PATCH", body: JSON.stringify(body) }));

beforeEach(() => {
  auth.isAuthenticated.mockReset().mockResolvedValue(true);
  auth.getSessionRole.mockReset().mockResolvedValue("admin");
  db.listAmeubloTestVideos.mockReset().mockResolvedValue([]);
  db.setAmeubloTestVerdict.mockReset().mockResolvedValue(true);
});

describe("/api/ameublo/videos (Studio Ameublo)", () => {
  it("requires a session", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await GET()).status).toBe(401);
    expect((await patch({ id: 1, verdict: "ok" })).status).toBe(401);
  });

  it("lists the test videos in the { success, data } shape", async () => {
    db.listAmeubloTestVideos.mockResolvedValue([{ id: 1 }]);
    const j = await (await GET()).json();
    expect(j).toEqual({ success: true, data: { videos: [{ id: 1 }] } });
  });

  it("records a verdict and a note", async () => {
    const res = await patch({ id: 3, verdict: "bad", note: "le bras coupe le texte" });
    expect(res.status).toBe(200);
    expect(db.setAmeubloTestVerdict).toHaveBeenCalledWith(3, "bad", "le bras coupe le texte");
  });

  it("clears a verdict with null", async () => {
    await patch({ id: 3, verdict: null });
    expect(db.setAmeubloTestVerdict).toHaveBeenCalledWith(3, null, undefined);
  });

  it("rejects a bad verdict or id, and an unknown video", async () => {
    expect((await patch({ id: 3, verdict: "maybe" })).status).toBe(400);
    expect((await patch({ id: -1, verdict: "ok" })).status).toBe(400);
    db.setAmeubloTestVerdict.mockResolvedValue(false);
    expect((await patch({ id: 99, verdict: "ok" })).status).toBe(404);
  });

  it("is read-only for reviewers", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await patch({ id: 3, verdict: "ok" })).status).toBe(403);
    expect(db.setAmeubloTestVerdict).not.toHaveBeenCalled();
  });
});
