import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getSessionRole: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({
  listAmeubloTestVideos: vi.fn(),
  setAmeubloTestVerdict: vi.fn(),
  setAmeubloCaption: vi.fn(),
  getAmeubloTestVideo: vi.fn(),
  productTypesBySku: vi.fn(),
}));
vi.mock("@/lib/database", () => db);
const approval = vi.hoisted(() => ({ approveAmeubloVideo: vi.fn(), bulkApproveAmeubloVideos: vi.fn(), cancelAmeubloVideo: vi.fn() }));
vi.mock("@/lib/ameublo-approval", () => approval);

import { GET, PATCH, POST } from "@/app/api/ameublo/videos/route";

const patch = (body: unknown) =>
  PATCH(new Request("http://x/api/ameublo/videos", { method: "PATCH", body: JSON.stringify(body) }));

beforeEach(() => {
  Object.values(approval).forEach((f) => f.mockReset());
  auth.isAuthenticated.mockReset().mockResolvedValue(true);
  auth.getSessionRole.mockReset().mockResolvedValue("admin");
  db.listAmeubloTestVideos.mockReset().mockResolvedValue([]);
  db.productTypesBySku.mockReset().mockResolvedValue(new Map());
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
    expect(j.success).toBe(true);
    expect(j.data.videos).toHaveLength(1);
    expect(j.data.videos[0]).toMatchObject({ id: 1, category: "autres", category_label: "Autres", sub_category: "Autres" });
  });

  it("tags each video with the category of what is on screen, falling back to the comma-separated sku", async () => {
    db.productTypesBySku.mockResolvedValue(
      new Map([
        ["A1", "Pet Supplies > Cat Supplies > Cat Trees"],
        ["H1", "Home Furnishings > Holiday & Seasonal > Halloween Decorations"],
      ]),
    );
    db.listAmeubloTestVideos.mockResolvedValue([
      { id: 1, skus: ["A1"], sku: "A1", label: "Arbre à chat", campaign: "maison-2026" },
      { id: 2, skus: [], sku: "H1", label: "Fantôme gonflable 6 pi", campaign: "maison-2026" },
    ]);
    const j = await (await GET()).json();
    expect(db.productTypesBySku).toHaveBeenCalledWith(["A1", "H1"]);
    expect(j.data.videos.map((v: { category: string; sub_category: string }) => [v.category, v.sub_category])).toEqual([
      ["animaux", "Chats"],
      ["halloween", "Gonflables"],
    ]);
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

  const post = (body: unknown) =>
    POST(new Request("http://x/api/ameublo/videos", { method: "POST", body: JSON.stringify(body) }));

  it("approves one video, passing force through, and mirrors the failure status", async () => {
    approval.approveAmeubloVideo.mockResolvedValue({ success: true, id: 4, queueId: 9, scheduledAt: "2026-10-06 11:45:00" });
    expect((await post({ action: "approve", id: 4, force: true })).status).toBe(200);
    expect(approval.approveAmeubloVideo).toHaveBeenCalledWith(4, { force: true });
    approval.approveAmeubloVideo.mockResolvedValue({ success: false, id: 4, error: "prix", status: 409 });
    expect((await post({ action: "approve", id: 4 })).status).toBe(409);
  });

  it("bulk-approves up to 100 ids and reports counts", async () => {
    approval.bulkApproveAmeubloVideos.mockResolvedValue([{ success: true }, { success: false }]);
    const j = await (await post({ action: "bulk_approve", ids: [1, 2] })).json();
    expect(j.data).toMatchObject({ approved: 1, refused: 1 });
    expect((await post({ action: "bulk_approve", ids: [] })).status).toBe(400);
  });

  it("edits a caption only while the video is not scheduled", async () => {
    db.getAmeubloTestVideo.mockResolvedValue({ id: 2, queue_status: null });
    db.setAmeubloCaption.mockResolvedValue(true);
    expect((await post({ action: "caption", id: 2, caption: "Salut" })).status).toBe(200);
    db.getAmeubloTestVideo.mockResolvedValue({ id: 2, queue_status: "pending" });
    expect((await post({ action: "caption", id: 2, caption: "Salut" })).status).toBe(409);
  });

  it("is admin-only for POST", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await post({ action: "approve", id: 4 })).status).toBe(403);
    expect(approval.approveAmeubloVideo).not.toHaveBeenCalled();
  });
});
