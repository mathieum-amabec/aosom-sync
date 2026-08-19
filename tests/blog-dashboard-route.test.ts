import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers /api/blog/[action] — the /blog dashboard's queue + approve/publish/delete actions.
// The DB and the Shopify client are mocked; what is verified here is the routing (one dynamic
// segment serving four operations), the auth gates, the status-machine guards, and the
// Shopify-before-DB ordering on publish.

const DRAFT_POST = {
  id: 7,
  title: "Aménager un petit balcon",
  lang: "fr" as const,
  status: "draft" as const,
  shopify_article_id: "999",
  approved_at: null,
  published_at: null,
  created_at: 1_700_000_000,
};

const COUNTS = { draft: 1, approved: 0, published: 2, failed: 0 };

function mockAuth(over: { authed?: boolean; role?: string } = {}) {
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(over.authed ?? true),
    getSessionRole: vi.fn().mockResolvedValue(over.role ?? "admin"),
  }));
}

function mockDeps(over: Record<string, unknown> = {}) {
  const db = {
    listBlogPosts: vi.fn().mockResolvedValue([DRAFT_POST]),
    countBlogPostsByStatus: vi.fn().mockResolvedValue(COUNTS),
    getBlogPost: vi.fn().mockResolvedValue(DRAFT_POST),
    approveBlogPost: vi.fn().mockResolvedValue(true),
    markBlogPostPublished: vi.fn().mockResolvedValue(true),
    deleteBlogPost: vi.fn().mockResolvedValue(true),
    BLOG_POST_STATUSES: ["draft", "approved", "published", "failed"],
    ...over,
  };
  const publishBlogArticle = (over.publishBlogArticle as ReturnType<typeof vi.fn>)
    ?? vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/lib/database", () => db);
  vi.doMock("@/lib/shopify-blog", () => ({
    publishBlogArticle,
    blogIdFor: (lang: string) => (lang === "fr" ? 90302349417 : 91161428073),
  }));
  vi.doMock("@/lib/config", () => ({
    BLOG: { ADMIN_ARTICLE_URL: (id: string) => `https://admin.example/articles/${id}` },
  }));
  return { db, publishBlogArticle };
}

function params(action: string) {
  return { params: Promise.resolve({ action }) };
}

function req(action: string, init?: RequestInit) {
  return new Request(`http://localhost/api/blog/${action}`, init);
}

function jsonPost(action: string, body: unknown) {
  return req(action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/blog/queue", () => {
  beforeEach(() => vi.resetModules());

  it("returns posts with a Shopify admin url plus whole-table status counts", async () => {
    mockAuth();
    const { db } = mockDeps();
    const { GET } = await import("@/app/api/blog/[action]/route");

    const res = await GET(req("queue"), params("queue"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.posts[0].adminUrl).toBe("https://admin.example/articles/999");
    expect(body.data.counts).toEqual(COUNTS);
    expect(db.listBlogPosts).toHaveBeenCalledWith(100, { lang: undefined, status: undefined });
  });

  it("passes lang + status filters through to the query", async () => {
    mockAuth();
    const { db } = mockDeps();
    const { GET } = await import("@/app/api/blog/[action]/route");

    await GET(
      new Request("http://localhost/api/blog/queue?lang=en&status=approved&limit=5"),
      params("queue"),
    );
    expect(db.listBlogPosts).toHaveBeenCalledWith(5, { lang: "en", status: "approved" });
  });

  it("drops bogus filter values instead of erroring", async () => {
    mockAuth();
    const { db } = mockDeps();
    const { GET } = await import("@/app/api/blog/[action]/route");

    await GET(
      new Request("http://localhost/api/blog/queue?lang=es&status=zzz"),
      params("queue"),
    );
    expect(db.listBlogPosts).toHaveBeenCalledWith(100, { lang: undefined, status: undefined });
  });

  it("404s an unknown GET action", async () => {
    mockAuth();
    mockDeps();
    const { GET } = await import("@/app/api/blog/[action]/route");

    const res = await GET(req("nope"), params("nope"));
    expect(res.status).toBe(404);
  });

  it("401s an anonymous caller", async () => {
    mockAuth({ authed: false });
    mockDeps();
    const { GET } = await import("@/app/api/blog/[action]/route");

    const res = await GET(req("queue"), params("queue"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/blog/approve", () => {
  beforeEach(() => vi.resetModules());

  it("flips a draft to approved", async () => {
    mockAuth();
    const { db } = mockDeps();
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("approve", { id: 7 }), params("approve"));
    expect(res.status).toBe(200);
    expect(db.approveBlogPost).toHaveBeenCalledWith(7);
  });

  it("409s when the article is not a draft", async () => {
    mockAuth();
    const { db } = mockDeps({
      getBlogPost: vi.fn().mockResolvedValue({ ...DRAFT_POST, status: "published" }),
    });
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("approve", { id: 7 }), params("approve"));
    expect(res.status).toBe(409);
    expect(db.approveBlogPost).not.toHaveBeenCalled();
  });

  it("409s when a concurrent approval already won the race", async () => {
    mockAuth();
    mockDeps({ approveBlogPost: vi.fn().mockResolvedValue(false) });
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("approve", { id: 7 }), params("approve"));
    expect(res.status).toBe(409);
  });

  it("404s an unknown article", async () => {
    mockAuth();
    mockDeps({ getBlogPost: vi.fn().mockResolvedValue(null) });
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("approve", { id: 7 }), params("approve"));
    expect(res.status).toBe(404);
  });

  it("400s a non-numeric id", async () => {
    mockAuth();
    mockDeps();
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("approve", { id: "abc" }), params("approve"));
    expect(res.status).toBe(400);
  });

  it("403s a reviewer session", async () => {
    mockAuth({ role: "reviewer" });
    const { db } = mockDeps();
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("approve", { id: 7 }), params("approve"));
    expect(res.status).toBe(403);
    expect(db.approveBlogPost).not.toHaveBeenCalled();
  });
});

describe("POST /api/blog/publish", () => {
  beforeEach(() => vi.resetModules());

  it("publishes on Shopify first, then marks the row published", async () => {
    mockAuth();
    const { db, publishBlogArticle } = mockDeps({
      getBlogPost: vi.fn().mockResolvedValue({ ...DRAFT_POST, status: "approved" }),
    });
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("publish", { id: 7 }), params("publish"));
    expect(res.status).toBe(200);
    expect(publishBlogArticle).toHaveBeenCalledWith(90302349417, "999");
    expect(db.markBlogPostPublished).toHaveBeenCalledWith(7);
  });

  it("routes an EN article to the English blog id", async () => {
    mockAuth();
    const { publishBlogArticle } = mockDeps({
      getBlogPost: vi.fn().mockResolvedValue({ ...DRAFT_POST, lang: "en", status: "approved" }),
    });
    const { POST } = await import("@/app/api/blog/[action]/route");

    await POST(jsonPost("publish", { id: 7 }), params("publish"));
    expect(publishBlogArticle).toHaveBeenCalledWith(91161428073, "999");
  });

  it("409s an article that has not been approved yet", async () => {
    mockAuth();
    const { publishBlogArticle } = mockDeps();
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("publish", { id: 7 }), params("publish"));
    expect(res.status).toBe(409);
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("409s an approved row with no Shopify article attached", async () => {
    mockAuth();
    const { publishBlogArticle } = mockDeps({
      getBlogPost: vi.fn().mockResolvedValue({
        ...DRAFT_POST, status: "approved", shopify_article_id: null,
      }),
    });
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("publish", { id: 7 }), params("publish"));
    expect(res.status).toBe(409);
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("leaves the row approved (502) when Shopify rejects the publish", async () => {
    mockAuth();
    const { db } = mockDeps({
      getBlogPost: vi.fn().mockResolvedValue({ ...DRAFT_POST, status: "approved" }),
      publishBlogArticle: vi.fn().mockRejectedValue(new Error("Shopify blog article publish failed: 422")),
    });
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("publish", { id: 7 }), params("publish"));
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.code).toBe("shopify_error");
    // The upstream message (which can carry Shopify payload detail) never reaches the client.
    expect(body.error).not.toContain("422");
    expect(db.markBlogPostPublished).not.toHaveBeenCalled();
  });

  it("404s an unknown POST action", async () => {
    mockAuth();
    mockDeps();
    const { POST } = await import("@/app/api/blog/[action]/route");

    const res = await POST(jsonPost("frobnicate", { id: 7 }), params("frobnicate"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/blog/:id", () => {
  beforeEach(() => vi.resetModules());

  it("deletes the dashboard row without touching Shopify", async () => {
    mockAuth();
    const { db, publishBlogArticle } = mockDeps();
    const { DELETE } = await import("@/app/api/blog/[action]/route");

    const res = await DELETE(req("7", { method: "DELETE" }), params("7"));
    expect(res.status).toBe(200);
    expect(db.deleteBlogPost).toHaveBeenCalledWith(7);
    expect(publishBlogArticle).not.toHaveBeenCalled();
  });

  it("404s a row that is already gone", async () => {
    mockAuth();
    mockDeps({ deleteBlogPost: vi.fn().mockResolvedValue(false) });
    const { DELETE } = await import("@/app/api/blog/[action]/route");

    const res = await DELETE(req("7", { method: "DELETE" }), params("7"));
    expect(res.status).toBe(404);
  });

  it("400s a non-numeric segment (an action name is not an id)", async () => {
    mockAuth();
    const { db } = mockDeps();
    const { DELETE } = await import("@/app/api/blog/[action]/route");

    const res = await DELETE(req("approve", { method: "DELETE" }), params("approve"));
    expect(res.status).toBe(400);
    expect(db.deleteBlogPost).not.toHaveBeenCalled();
  });

  it("400s a numeric-ish segment with trailing junk (parseInt would truncate it)", async () => {
    mockAuth();
    const { db } = mockDeps();
    const { DELETE } = await import("@/app/api/blog/[action]/route");

    const res = await DELETE(req("7abc", { method: "DELETE" }), params("7abc"));
    expect(res.status).toBe(400);
    expect(db.deleteBlogPost).not.toHaveBeenCalled();
  });

  it("403s a reviewer session", async () => {
    mockAuth({ role: "reviewer" });
    const { db } = mockDeps();
    const { DELETE } = await import("@/app/api/blog/[action]/route");

    const res = await DELETE(req("7", { method: "DELETE" }), params("7"));
    expect(res.status).toBe(403);
    expect(db.deleteBlogPost).not.toHaveBeenCalled();
  });
});
