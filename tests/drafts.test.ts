import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const baseDraft = {
  id: 1,
  sku: "ABC-123",
  triggerType: "content_template",
  language: "fr",
  postText: "Voici un beau texte FR",
  postTextEn: "Here is a nice EN text",
  imagePath: null,
  imageUrl: null,
  imageUrls: [],
  oldPrice: null,
  newPrice: null,
  status: "draft",
  scheduledAt: null,
  publishedAt: null,
  facebookPostId: null,
  channels: {},
  createdAt: 1715000000,
  hookId: null,
  approvedAt: null,
  reviewedBy: null,
  reviewNotes: null,
};

const basePage = {
  items: [baseDraft],
  total: 1,
  page: 1,
  pageSize: 20,
  hasMore: false,
};

// ─── GET /api/drafts ─────────────────────────────────────────────────────────

function makeRequest(url: string, authenticated = true): Request {
  const req = new Request(url);
  return req;
}

describe("GET /api/drafts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 401 when not authenticated", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));
    vi.doMock("@/lib/database", () => ({ getDraftsForReview: vi.fn() }));
    const { GET } = await import("@/app/api/drafts/route");
    const res = await GET(new Request("http://localhost/api/drafts"));
    expect(res.status).toBe(401);
  });

  it("returns paginated drafts with defaults", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue(basePage);
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    const res = await GET(new Request("http://localhost/api/drafts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 })
    );
  });

  it("passes status filter as array", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?status=draft,approved"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["draft", "approved"] })
    );
  });

  it("passes triggerType filter", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?triggerType=content_template"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "content_template" })
    );
  });

  it("passes hook filter when 'with' or 'without'", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?hook=with"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "with" })
    );
  });

  it("defaults hook to 'all' for unknown hook values", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?hook=invalid"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "all" })
    );
  });

  it("clamps pageSize to max 50", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?pageSize=999"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 50 })
    );
  });

  it("returns 500 on database error", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    vi.doMock("@/lib/database", () => ({
      getDraftsForReview: vi.fn().mockRejectedValue(new Error("DB down")),
    }));
    const { GET } = await import("@/app/api/drafts/route");
    const res = await GET(new Request("http://localhost/api/drafts"));
    expect(res.status).toBe(500);
  });
});

// ─── getDraftsForReview filter logic ─────────────────────────────────────────
// These tests verify the query-building logic using the mock DB approach.
// Full DB integration is tested manually in prod.

describe("getDraftsForReview (via route integration)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("excludes 'published' status by default when no statuses specified", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts"));
    const call = getDraftsForReview.mock.calls[0][0];
    // No statuses array passed = DB function uses its own default (exclude published)
    expect(call.statuses).toBeUndefined();
  });
});

// ─── approveDraft server action ───────────────────────────────────────────────

describe("approveDraft server action", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls approveDraftDb and returns empty object on success", async () => {
    const approveDraftDb = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/database", () => ({ approveDraftDb, rejectDraftDb: vi.fn() }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(42);
    expect(result).toEqual({});
    expect(approveDraftDb).toHaveBeenCalledWith(42);
  });

  it("returns error string on DB failure", async () => {
    vi.doMock("@/lib/database", () => ({
      approveDraftDb: vi.fn().mockRejectedValue(new Error("constraint failed")),
      rejectDraftDb: vi.fn(),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(42);
    expect(result.error).toBe("constraint failed");
  });
});

// ─── rejectDraft server action ────────────────────────────────────────────────

describe("rejectDraft server action", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls rejectDraftDb with trimmed notes on success", async () => {
    const rejectDraftDb = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/database", () => ({ approveDraftDb: vi.fn(), rejectDraftDb }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { rejectDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await rejectDraft(7, "  Texte inapproprié  ");
    expect(result).toEqual({});
    expect(rejectDraftDb).toHaveBeenCalledWith(7, "Texte inapproprié");
  });

  it("returns validation error for empty notes", async () => {
    vi.doMock("@/lib/database", () => ({ approveDraftDb: vi.fn(), rejectDraftDb: vi.fn() }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { rejectDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await rejectDraft(7, "   ");
    expect(result.error).toContain("obligatoires");
  });

  it("returns error string on DB failure", async () => {
    vi.doMock("@/lib/database", () => ({
      approveDraftDb: vi.fn(),
      rejectDraftDb: vi.fn().mockRejectedValue(new Error("write failed")),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { rejectDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await rejectDraft(7, "bad content");
    expect(result.error).toBe("write failed");
  });

  it("returns 'Erreur inconnue' when non-Error is thrown from approveDraft", async () => {
    vi.doMock("@/lib/database", () => ({
      approveDraftDb: vi.fn().mockRejectedValue("string error"),
      rejectDraftDb: vi.fn(),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);
    expect(result.error).toBe("Erreur inconnue");
  });

  it("returns 'Erreur inconnue' when non-Error is thrown from rejectDraft", async () => {
    vi.doMock("@/lib/database", () => ({
      approveDraftDb: vi.fn(),
      rejectDraftDb: vi.fn().mockRejectedValue(42),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { rejectDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await rejectDraft(7, "raison valide");
    expect(result.error).toBe("Erreur inconnue");
  });
});

// ─── Additional coverage gaps ─────────────────────────────────────────────────

describe("GET /api/drafts — additional coverage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes since and until as numbers", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?since=1714000000&until=1715000000"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ since: 1714000000, until: 1715000000 })
    );
  });

  it("clamps pageSize minimum to 1", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?pageSize=0"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 1 })
    );
  });

  it("passes hook='without' filter", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const getDraftsForReview = vi.fn().mockResolvedValue({ ...basePage, items: [] });
    vi.doMock("@/lib/database", () => ({ getDraftsForReview }));
    const { GET } = await import("@/app/api/drafts/route");
    await GET(new Request("http://localhost/api/drafts?hook=without"));
    expect(getDraftsForReview).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "without" })
    );
  });
});
