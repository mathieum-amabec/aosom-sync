import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── selectRandomTemplate ────────────────────────────────────────────────────

describe("selectRandomTemplate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when no active templates exist", async () => {
    vi.doMock("@/lib/database", () => ({
      getContentTemplates: vi.fn().mockResolvedValue([]),
    }));
    const { selectRandomTemplate } = await import("@/lib/content-template-selector");
    const result = await selectRandomTemplate();
    expect(result).toBeNull();
  });

  it("returns the only template when exactly one exists", async () => {
    const template = { id: 1, slug: "conseil_deco_piece", content_type: "education", mode: "generative_seeded", frequency_per_month: 2, scopes: ["universal"], active: true, display_name_fr: "", display_name_en: "", prompt_pattern_fr: "", prompt_pattern_en: "", image_strategy: "none" };
    vi.doMock("@/lib/database", () => ({
      getContentTemplates: vi.fn().mockResolvedValue([template]),
    }));
    const { selectRandomTemplate } = await import("@/lib/content-template-selector");
    const result = await selectRandomTemplate();
    expect(result?.slug).toBe("conseil_deco_piece");
  });

  it("weights selection by frequency_per_month", async () => {
    const high = { id: 1, slug: "high_freq", content_type: "education", mode: "generative_seeded", frequency_per_month: 9, scopes: [], active: true, display_name_fr: "", display_name_en: "", prompt_pattern_fr: "", prompt_pattern_en: "", image_strategy: "none" };
    const low  = { id: 2, slug: "low_freq",  content_type: "engagement", mode: "hook_seeded",       frequency_per_month: 1, scopes: [], active: true, display_name_fr: "", display_name_en: "", prompt_pattern_fr: "", prompt_pattern_en: "", image_strategy: "none" };
    vi.doMock("@/lib/database", () => ({
      getContentTemplates: vi.fn().mockResolvedValue([high, low]),
    }));
    const { selectRandomTemplate } = await import("@/lib/content-template-selector");

    let highCount = 0;
    const RUNS = 500;
    for (let i = 0; i < RUNS; i++) {
      const result = await selectRandomTemplate();
      if (result?.slug === "high_freq") highCount++;
    }
    // 9/(9+1) = 90% expected; allow ±10% margin
    expect(highCount / RUNS).toBeGreaterThan(0.80);
    expect(highCount / RUNS).toBeLessThan(1.00);
  });

  it("treats frequency_per_month=0 as weight 1 (never excluded)", async () => {
    const t = { id: 1, slug: "zero_freq", content_type: "education", mode: "generative_seeded", frequency_per_month: 0, scopes: [], active: true, display_name_fr: "", display_name_en: "", prompt_pattern_fr: "", prompt_pattern_en: "", image_strategy: "none" };
    vi.doMock("@/lib/database", () => ({
      getContentTemplates: vi.fn().mockResolvedValue([t]),
    }));
    const { selectRandomTemplate } = await import("@/lib/content-template-selector");
    const result = await selectRandomTemplate();
    expect(result?.slug).toBe("zero_freq");
  });
});

// ─── GET /api/cron/content ───────────────────────────────────────────────────

function makeRequest(cronSecret = "test-secret-123"): Request {
  return new Request("https://aosom-sync.vercel.app/api/cron/content", {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
}

describe("GET /api/cron/content", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret-123";
  });

  it("returns 401 for missing auth", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({ selectRandomTemplate: vi.fn() }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(new Request("https://aosom-sync.vercel.app/api/cron/content"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong secret", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({ selectRandomTemplate: vi.fn() }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest("wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("returns 503 when no active templates", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue(null),
    }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/No active templates/);
  });

  it("returns 500 when generate endpoint fails", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue({ id: 1, slug: "conseil_deco_piece", content_type: "education" }),
    }));
    // Fresh Response per call — a body can only be read once.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ success: false, error: "Claude timeout" }), { status: 502 })
    )));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.template).toBe("conseil_deco_piece");
  });

  it("returns 200 with FR + EN drafts on success", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue({ id: 3, slug: "sondage_debat", content_type: "engagement" }),
    }));
    // Fresh Response per call — a body can only be read once.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ success: true, draftId: 99, hookId: 7 }), { status: 200 })
    )));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.generated).toBe(2);
    expect(body.template).toBe("sondage_debat");
    expect(body.contentType).toBe("engagement");
    expect(body.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.drafts).toHaveLength(2);
    expect(body.drafts[0]).toMatchObject({ language: "fr", success: true, draftId: 99, hookId: 7 });
    expect(body.drafts[1]).toMatchObject({ language: "en", success: true, draftId: 99, hookId: 7 });
  });

  it("returns 200 with partial success when only EN fails", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue({ id: 1, slug: "conseil_deco_piece", content_type: "education" }),
    }));
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, draftId: 11, hookId: null }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "Claude timeout" }), { status: 502 }),
      );
    vi.stubGlobal("fetch", mockFetch);
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.generated).toBe(1);
    expect(body.drafts[0]).toMatchObject({ language: "fr", success: true, draftId: 11 });
    expect(body.drafts[1]).toMatchObject({ language: "en", success: false });
  });

  it("returns 500 when both generate calls fail (network error)", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue({ id: 1, slug: "conseil_deco_piece", content_type: "education" }),
    }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.generated).toBe(0);
    expect(body.drafts[0].error).toMatch(/unreachable/);
    expect(body.drafts[1].error).toMatch(/unreachable/);
  });

  it("calls generate twice — FR then EN — with correct slug and Bearer auth", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue({ id: 2, slug: "guide_achat_categorie", content_type: "education" }),
    }));
    // Fresh Response per call — a body can only be read once.
    const mockFetch = vi.fn();
    mockFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ success: true, draftId: 50, hookId: null }), { status: 200 }),
    ));
    vi.stubGlobal("fetch", mockFetch);
    const { GET } = await import("@/app/api/cron/content/route");
    await GET(makeRequest());

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [urlFr, optsFr] = mockFetch.mock.calls[0];
    expect(urlFr).toContain("/api/social/content/generate");
    expect(optsFr.method).toBe("POST");
    expect(optsFr.headers.Authorization).toBe("Bearer test-secret-123");
    const bodyFr = JSON.parse(optsFr.body);
    expect(bodyFr.templateSlug).toBe("guide_achat_categorie");
    expect(bodyFr.language).toBe("fr");

    const [, optsEn] = mockFetch.mock.calls[1];
    const bodyEn = JSON.parse(optsEn.body);
    expect(bodyEn.templateSlug).toBe("guide_achat_categorie");
    expect(bodyEn.language).toBe("en");
  });
});
