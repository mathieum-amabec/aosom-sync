import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers POST /api/blog/generate — the HTTP trust boundary in front of paid Anthropic work.
// The route is a thin wrapper now (generation lives in lib/blog-generator.ts), so what needs
// coverage here is exactly what the wrapper owns: auth, body validation, and error mapping.

process.env.CRON_SECRET = "test-cron-secret";
const CRON_AUTH = { authorization: "Bearer test-cron-secret", "content-type": "application/json" };
const JSON_ONLY = { "content-type": "application/json" };

const OK_RESULT = {
  articleId: "555",
  adminUrl: "https://admin.example/articles/555",
  handle: "handle",
  blogId: 90302349417,
  title: "Titre",
  imagesUsed: [],
  score: 90,
  published: true,
  publishReason: "published (score 90)",
};

interface Overrides {
  generateBlogArticle?: ReturnType<typeof vi.fn>;
  isAuthenticated?: ReturnType<typeof vi.fn>;
  isAdmin?: ReturnType<typeof vi.fn>;
  allowed?: boolean;
}

async function loadRoute(o: Overrides = {}) {
  const generateBlogArticle = o.generateBlogArticle ?? vi.fn().mockResolvedValue(OK_RESULT);
  const isAuthenticated = o.isAuthenticated ?? vi.fn().mockResolvedValue(false);
  const isAdmin = o.isAdmin ?? vi.fn().mockResolvedValue(false);

  vi.doMock("@/lib/blog-generator", () => ({ generateBlogArticle }));
  vi.doMock("@/lib/auth", () => ({ isAuthenticated, isAdmin }));
  // The real limiter is process-global; mock it so test ordering can't trip the 6/min cap.
  vi.doMock("@/lib/rate-limiter", () => ({
    checkRateLimit: vi.fn().mockReturnValue({ allowed: o.allowed ?? true, retryAfterMs: 30_000 }),
  }));

  const route = await import("@/app/api/blog/generate/route");
  return { route, generateBlogArticle, isAuthenticated, isAdmin };
}

function post(body: unknown, headers: Record<string, string> = CRON_AUTH) {
  return new Request("https://aosom-sync.vercel.app/api/blog/generate", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { topic: "Aménager un petit salon", lang: "fr" };

describe("POST /api/blog/generate — auth", () => {
  beforeEach(() => vi.resetModules());

  it("401s an anonymous caller with no cron secret", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    const res = await route.POST(post(VALID, JSON_ONLY));
    expect(res.status).toBe(401);
    expect(generateBlogArticle).not.toHaveBeenCalled();
  });

  it("403s a logged-in non-admin — paid Anthropic spend stays admin-only", async () => {
    const { route, generateBlogArticle } = await loadRoute({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      isAdmin: vi.fn().mockResolvedValue(false),
    });
    const res = await route.POST(post(VALID, JSON_ONLY));
    expect(res.status).toBe(403);
    expect(generateBlogArticle).not.toHaveBeenCalled();
  });

  it("accepts a logged-in admin session", async () => {
    const { route, generateBlogArticle } = await loadRoute({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      isAdmin: vi.fn().mockResolvedValue(true),
    });
    const res = await route.POST(post(VALID, JSON_ONLY));
    expect(res.status).toBe(200);
    expect(generateBlogArticle).toHaveBeenCalledTimes(1);
  });

  it("accepts the server-to-server cron secret without any session", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    const res = await route.POST(post(VALID));
    expect(res.status).toBe(200);
    expect(generateBlogArticle).toHaveBeenCalledTimes(1);
  });

  it("429s when the rate limiter refuses, before touching the generator", async () => {
    const { route, generateBlogArticle } = await loadRoute({ allowed: false });
    const res = await route.POST(post(VALID));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(generateBlogArticle).not.toHaveBeenCalled();
  });
});

describe("POST /api/blog/generate — body validation", () => {
  beforeEach(() => vi.resetModules());

  const badBodies: [string, unknown][] = [
    ["malformed JSON", "{not json"],
    ["a non-object body", 42],
    ["a missing topic", { lang: "fr" }],
    ["an empty topic", { topic: "   ", lang: "fr" }],
    ["an over-long topic", { topic: "x".repeat(201), lang: "fr" }],
    ["a missing lang", { topic: "Sujet" }],
    ["an unsupported lang", { topic: "Sujet", lang: "es" }],
    ["a non-array keywords", { topic: "Sujet", lang: "fr", keywords: "deco" }],
    ["an invalid season", { topic: "Sujet", lang: "fr", season: "monsoon" }],
  ];

  for (const [label, body] of badBodies) {
    it(`400s on ${label}`, async () => {
      const { route, generateBlogArticle } = await loadRoute();
      const res = await route.POST(post(body));
      expect(res.status).toBe(400);
      expect(generateBlogArticle).not.toHaveBeenCalled();
    });
  }

  it("passes through the parsed, trimmed input", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    await route.POST(
      post({
        topic: "  Petit salon  ",
        lang: "en",
        keywords: ["  deco  ", "", 42, "salon"],
        season: "summer",
        autoPublish: true,
      }),
    );

    const arg = generateBlogArticle.mock.calls[0][0];
    expect(arg.topic).toBe("Petit salon");
    expect(arg.lang).toBe("en");
    expect(arg.keywords).toEqual(["deco", "salon"]); // blanks and non-strings dropped
    expect(arg.season).toBe("summer");
    expect(arg.autoPublish).toBe(true);
  });

  it("defaults autoPublish to false so a manual call never publishes by accident", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    await route.POST(post(VALID));
    expect(generateBlogArticle.mock.calls[0][0].autoPublish).toBe(false);
  });

  it("ignores a malformed images field instead of rejecting the request", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    const res = await route.POST(post({ ...VALID, images: [{ id: "a" }, "nope", null] }));
    expect(res.status).toBe(200);
    // Undefined → the generator falls back to its own Unsplash search.
    expect(generateBlogArticle.mock.calls[0][0].images).toBeUndefined();
  });
});

describe("POST /api/blog/generate — error mapping", () => {
  beforeEach(() => vi.resetModules());

  const cases: [string, string, string][] = [
    ["Shopify failures", "Shopify blog article create failed: 422", "shopify_error"],
    ["Unsplash failures", "Unsplash returned no results for \"x\"", "unsplash_error"],
    ["Claude failures", "Claude returned invalid JSON: ...", "claude_error"],
    ["anything else", "socket hang up", "internal_error"],
  ];

  for (const [label, message, code] of cases) {
    it(`maps ${label} to ${code} without leaking the upstream message`, async () => {
      const { route } = await loadRoute({
        generateBlogArticle: vi.fn().mockRejectedValue(new Error(message)),
      });
      const res = await route.POST(post(VALID));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.code).toBe(code);
      expect(body.error).toBe("Blog generation failed");
      // The raw upstream text stays in server logs only.
      expect(JSON.stringify(body)).not.toContain(message);
    });
  }
});
