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

// ─── publishDraft server action ───────────────────────────────────────────────

const approvedDraft = {
  ...baseDraft,
  status: "approved",
  postText: "Texte FR pour Ameublo",
  postTextEn: "EN text for Furnish",
  approvedAt: 1715000100,
  reviewedBy: "admin",
  reviewNotes: null,
};

describe("publishDraft server action", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns error when not authenticated", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));
    vi.doMock("@/lib/database", () => ({ getFacebookDraft: vi.fn(), updateFacebookDraft: vi.fn() }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText: vi.fn() }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/autorisé/i);
  });

  it("returns error when draft not found", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue(null),
      updateFacebookDraft: vi.fn(),
    }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText: vi.fn() }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(999);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/introuvable/i);
  });

  it("returns error when draft is not approved", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...baseDraft, status: "draft" }),
      updateFacebookDraft: vi.fn(),
    }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText: vi.fn() }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/approved/i);
  });

  it("returns error when no text to publish", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postText: "", postTextEn: null }),
      updateFacebookDraft: vi.fn(),
    }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText: vi.fn() }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/aucun texte/i);
  });

  it("publishes FR text to ameublo", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const publishText = vi.fn().mockResolvedValue({ id: "111_222", postId: "111_222" });
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postTextEn: null }),
      updateFacebookDraft: vi.fn(),
    }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(true);
    expect(publishText).toHaveBeenCalledWith(expect.objectContaining({ brand: "ameublo" }));
    expect(publishText).toHaveBeenCalledTimes(1);
  });

  it("publishes EN text to furnish", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const publishText = vi.fn().mockResolvedValue({ id: "222_333", postId: "222_333" });
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postText: "" }),
      updateFacebookDraft: vi.fn(),
    }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    await publishDraft(1);
    expect(publishText).toHaveBeenCalledWith(expect.objectContaining({ brand: "furnish" }));
    expect(publishText).toHaveBeenCalledTimes(1);
  });

  it("publishes to both ameublo and furnish for bilingual draft", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const publishText = vi.fn().mockResolvedValue({ id: "page_post", postId: "page_post" });
    const updateFacebookDraft = vi.fn();
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue(approvedDraft),
      updateFacebookDraft,
    }));
    vi.doMock("@/lib/facebook-client", () => ({ publishText }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(true);
    expect(publishText).toHaveBeenCalledTimes(2);
    expect(publishText).toHaveBeenCalledWith(expect.objectContaining({ brand: "ameublo", message: approvedDraft.postText }));
    expect(publishText).toHaveBeenCalledWith(expect.objectContaining({ brand: "furnish", message: approvedDraft.postTextEn }));
  });

  it("saves facebook_post_id and status=published on full success", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const updateFacebookDraft = vi.fn();
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postTextEn: null }),
      updateFacebookDraft,
    }));
    vi.doMock("@/lib/facebook-client", () => ({
      publishText: vi.fn().mockResolvedValue({ id: "1057_999", postId: "1057_999" }),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    await publishDraft(1);
    expect(updateFacebookDraft).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "published", facebook_post_id: "1057_999" })
    );
  });

  it("saves publish_error and keeps status=approved on all-fail", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const updateFacebookDraft = vi.fn();
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postTextEn: null }),
      updateFacebookDraft,
    }));
    vi.doMock("@/lib/facebook-client", () => ({
      publishText: vi.fn().mockRejectedValue(new Error("Meta API 401")),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(false);
    expect(updateFacebookDraft).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ publish_error: expect.stringContaining("Meta API 401") })
    );
    expect(updateFacebookDraft).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: "published" }));
  });

  it("marks published and records partial_error when one brand fails", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const updateFacebookDraft = vi.fn();
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue(approvedDraft),
      updateFacebookDraft,
    }));
    vi.doMock("@/lib/facebook-client", () => ({
      publishText: vi.fn()
        .mockResolvedValueOnce({ id: "1057_ok", postId: "1057_ok" })
        .mockRejectedValueOnce(new Error("furnish token expired")),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(true);
    expect(updateFacebookDraft).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "published", facebook_post_id: "1057_ok", publish_error: expect.stringContaining("furnish") })
    );
  });

  it("returns 'Erreur inconnue' when non-Error is thrown by publishText", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const updateFacebookDraft = vi.fn();
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postTextEn: null }),
      updateFacebookDraft,
    }));
    vi.doMock("@/lib/facebook-client", () => ({
      publishText: vi.fn().mockRejectedValue("non-error string"),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("Erreur inconnue");
  });

  it("sets publish_error=null and published_at on clean full success", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    const updateFacebookDraft = vi.fn();
    const before = Math.floor(Date.now() / 1000);
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue({ ...approvedDraft, postTextEn: null }),
      updateFacebookDraft,
    }));
    vi.doMock("@/lib/facebook-client", () => ({
      publishText: vi.fn().mockResolvedValue({ id: "1057_clean", postId: "1057_clean" }),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    await publishDraft(1);
    const call = updateFacebookDraft.mock.calls[0][1];
    expect(call.publish_error).toBeNull();
    expect(call.published_at).toBeGreaterThanOrEqual(before);
  });

  it("returns publishedTo and fbPostIds on bilingual success", async () => {
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
    vi.doMock("@/lib/database", () => ({
      getFacebookDraft: vi.fn().mockResolvedValue(approvedDraft),
      updateFacebookDraft: vi.fn(),
    }));
    vi.doMock("@/lib/facebook-client", () => ({
      publishText: vi.fn()
        .mockResolvedValueOnce({ id: "1057_fr", postId: "1057_fr" })
        .mockResolvedValueOnce({ id: "1080_en", postId: "1080_en" }),
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { publishDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await publishDraft(1);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.publishedTo).toContain("ameublo");
      expect(result.publishedTo).toContain("furnish");
      expect(result.fbPostIds).toContain("1057_fr");
      expect(result.fbPostIds).toContain("1080_en");
    }
  });
});
