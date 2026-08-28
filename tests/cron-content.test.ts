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

/**
 * The cron calls the generator IN-PROCESS. It used to fetch() its own
 * /api/social/content/generate, and Vercel's SSO Deployment Protection answered
 * that self-call 401 at the edge — 13 consecutive failed runs, 2026-07-29 to
 * 2026-08-26, zero drafts. These tests mock the lib, not fetch, and one of them
 * asserts fetch is never touched so the self-call cannot come back.
 */
function mockTemplate(slug: string, contentType = "education") {
  vi.doMock("@/lib/content-template-selector", () => ({
    selectRandomTemplate: vi.fn().mockResolvedValue({ id: 1, slug, content_type: contentType }),
  }));
}

describe("GET /api/cron/content", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env.CRON_SECRET = "test-secret-123";
  });

  it("returns 401 for missing auth", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({ selectRandomTemplate: vi.fn() }));
    vi.doMock("@/lib/content-template-generator", () => ({ generateContentTemplateDraft: vi.fn() }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(new Request("https://aosom-sync.vercel.app/api/cron/content"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong secret", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({ selectRandomTemplate: vi.fn() }));
    vi.doMock("@/lib/content-template-generator", () => ({ generateContentTemplateDraft: vi.fn() }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest("wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("returns 503 when no active templates", async () => {
    vi.doMock("@/lib/content-template-selector", () => ({
      selectRandomTemplate: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/content-template-generator", () => ({ generateContentTemplateDraft: vi.fn() }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/No active templates/);
  });

  it("returns 500 when generation fails for both languages", async () => {
    mockTemplate("conseil_deco_piece");
    vi.doMock("@/lib/content-template-generator", () => ({
      generateContentTemplateDraft: vi.fn().mockRejectedValue(new Error("Claude returned an empty response")),
    }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.template).toBe("conseil_deco_piece");
  });

  it("returns 200 with FR + EN drafts on success", async () => {
    mockTemplate("sondage_debat", "engagement");
    vi.doMock("@/lib/content-template-generator", () => ({
      generateContentTemplateDraft: vi.fn().mockResolvedValue({ draftId: 99, hookId: 7 }),
    }));
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
    mockTemplate("conseil_deco_piece");
    vi.doMock("@/lib/content-template-generator", () => ({
      generateContentTemplateDraft: vi.fn()
        .mockResolvedValueOnce({ draftId: 11, hookId: null })
        .mockRejectedValueOnce(new Error("Claude timeout")),
    }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.generated).toBe(1);
    expect(body.drafts[0]).toMatchObject({ language: "fr", success: true, draftId: 11 });
    expect(body.drafts[1]).toMatchObject({ language: "en", success: false });
  });

  it("propagates each language's error into the failure message (cron_runs.detail)", async () => {
    // Regression: the content cron only ever recorded the generic "Both FR and EN
    // content generations failed" wrapper in cron_runs.detail; the real
    // per-language cause stayed buried in Vercel logs. That is precisely how a 401
    // on the old self-fetch went unnoticed for four weeks. The thrown message
    // (re-thrown verbatim by trackCron → recordCronRun → cron_runs.detail, and
    // mirrored into the 500 response's `error`) must carry each language's cause.
    mockTemplate("conseil_deco_piece");
    vi.doMock("@/lib/content-template-generator", () => ({
      generateContentTemplateDraft: vi.fn().mockRejectedValue(new Error("Claude timeout")),
    }));
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Both FR and EN content generations failed");
    expect(body.error).toContain("FR: Claude timeout");
    expect(body.error).toContain("EN: Claude timeout");
  });

  it("calls the generator twice — FR then EN — with the selected slug", async () => {
    mockTemplate("guide_achat_categorie");
    const gen = vi.fn().mockResolvedValue({ draftId: 50, hookId: null });
    vi.doMock("@/lib/content-template-generator", () => ({ generateContentTemplateDraft: gen }));
    const { GET } = await import("@/app/api/cron/content/route");
    await GET(makeRequest());

    expect(gen).toHaveBeenCalledTimes(2);
    expect(gen.mock.calls[0]).toEqual(["guide_achat_categorie", "fr"]);
    expect(gen.mock.calls[1]).toEqual(["guide_achat_categorie", "en"]);
  });

  it("never calls fetch — the self-call is what SSO Deployment Protection 401'd", async () => {
    // The regression guard for the whole fix. If someone reintroduces a
    // fetch() to /api/social/content/generate, the cron silently goes back to
    // failing 100% of the time in production while passing every other test here.
    mockTemplate("astuces_entretien");
    vi.doMock("@/lib/content-template-generator", () => ({
      generateContentTemplateDraft: vi.fn().mockResolvedValue({ draftId: 5, hookId: null }),
    }));
    const spyFetch = vi.fn();
    vi.stubGlobal("fetch", spyFetch);
    const { GET } = await import("@/app/api/cron/content/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(spyFetch).not.toHaveBeenCalled();
  });
});
