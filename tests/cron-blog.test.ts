import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers GET /api/cron/blog.
//
// The load-bearing test here is "never reaches the network": this cron used to call its own
// /api/blog/generate endpoint over HTTP, and Vercel SSO Deployment Protection answered that
// self-call with a 401 before the app's CRON_SECRET check ran — 4/4 runs failed for weeks.
// Generation is now in-process, so any reintroduced fetch() is a regression.

process.env.CRON_SECRET = "test-cron-secret";
const AUTH = { authorization: "Bearer test-cron-secret" };

const OK_ARTICLE = {
  articleId: "111",
  adminUrl: "https://admin.example/articles/111",
  handle: "handle",
  blogId: 90302349417,
  title: "Titre",
  imagesUsed: [],
  score: 88,
  published: true,
  publishReason: "published (score 88)",
};

const IMG = (id: string) => ({
  id,
  url: `https://images.example/${id}.jpg`,
  altDescription: `alt ${id}`,
  photographer: `P${id}`,
  photographerUrl: `https://unsplash.example/@${id}`,
  unsplashUrl: "https://unsplash.example/",
  downloadLocation: `https://api.unsplash.example/${id}/download`,
});

interface Overrides {
  generateBlogArticle?: ReturnType<typeof vi.fn>;
  searchImages?: ReturnType<typeof vi.fn>;
  recordCronRun?: ReturnType<typeof vi.fn>;
  fetchCollectionProducts?: ReturnType<typeof vi.fn>;
}

async function loadRoute(o: Overrides = {}) {
  const generateBlogArticle = o.generateBlogArticle ?? vi.fn().mockResolvedValue(OK_ARTICLE);
  const searchImages = o.searchImages ?? vi.fn().mockResolvedValue([IMG("a"), IMG("b"), IMG("c")]);
  const triggerDownload = vi.fn().mockResolvedValue(undefined);
  const recordCronRun = o.recordCronRun ?? vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/lib/blog-generator", () => ({ generateBlogArticle }));
  vi.doMock("@/lib/unsplash", () => ({ searchImages, triggerDownload }));
  // Product lookup is Shopify I/O — mocked so the "no HTTP" guarantee below stays meaningful.
  const fetchCollectionProducts = o.fetchCollectionProducts ?? vi.fn().mockResolvedValue([]);
  vi.doMock("@/lib/blog-products", () => ({ fetchCollectionProducts }));
  // Real trackCron runs on top of this so the recorded detail string is asserted for real.
  vi.doMock("@/lib/database", () => ({ recordCronRun }));

  const route = await import("@/app/api/cron/blog/route");
  return { route, generateBlogArticle, searchImages, triggerDownload, recordCronRun, fetchCollectionProducts };
}

function req(headers: Record<string, string> = {}) {
  return new Request("https://aosom-sync.vercel.app/api/cron/blog", { headers });
}

describe("GET /api/cron/blog", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    // Any outbound HTTP from this route is a regression — fail loudly rather than silently
    // hitting the network during the test run.
    fetchSpy = vi.fn(() => {
      throw new Error("cron/blog must not make HTTP calls — generation is in-process");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("rejects a request with no CRON_SECRET", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    const res = await route.GET(req());
    expect(res.status).toBe(401);
    expect(generateBlogArticle).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong CRON_SECRET", async () => {
    const { route, generateBlogArticle } = await loadRoute();
    const res = await route.GET(req({ authorization: "Bearer wrong-secret-value" }));
    expect(res.status).toBe(401);
    expect(generateBlogArticle).not.toHaveBeenCalled();
  });

  it("generates FR + EN in-process and never issues an HTTP request", async () => {
    const { route, generateBlogArticle } = await loadRoute();

    const res = await route.GET(req(AUTH));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.generated).toBe(2);
    expect(generateBlogArticle).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();

    const langs = generateBlogArticle.mock.calls.map((c) => c[0].lang);
    expect(langs).toEqual(["fr", "en"]);
    // The cron opts into the auto-publish gate for both languages.
    expect(generateBlogArticle.mock.calls.every((c) => c[0].autoPublish === true)).toBe(true);
  });

  it("passes one shared photo set to both languages", async () => {
    const { route, generateBlogArticle, triggerDownload } = await loadRoute();

    await route.GET(req(AUTH));

    const [frArgs, enArgs] = generateBlogArticle.mock.calls.map((c) => c[0]);
    expect(frArgs.images).toHaveLength(3);
    expect(enArgs.images).toEqual(frArgs.images);
    // Pings fire once for the shared set, not once per language.
    expect(triggerDownload).toHaveBeenCalledTimes(3);
  });

  it("on a commercial topic, fetches the collection's products once and shares them FR + EN", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T08:00:00Z")); // first run of the season-first selector → Christmas trees
    try {
      const products = [{ handle: "sapin-a", titleFr: "Sapin A", titleEn: "Tree A", imageUrl: "https://cdn.shopify.com/a.jpg", factsFr: "x" }];
      const fetchCollectionProducts = vi.fn().mockResolvedValue(products);
      const { route, generateBlogArticle } = await loadRoute({ fetchCollectionProducts });

      const res = await route.GET(req(AUTH));
      const body = await res.json();

      expect(fetchCollectionProducts).toHaveBeenCalledTimes(1);
      expect(fetchCollectionProducts.mock.calls[0][0]).toBe("noel-sapins");
      expect(body.collection).toBe("noel-sapins");
      expect(body.season).toBe("holidays");
      expect(body.products).toBe(1);
      const [frArgs, enArgs] = generateBlogArticle.mock.calls.map((c) => c[0]);
      expect(frArgs.collection).toBe("noel-sapins");
      expect(frArgs.products).toEqual(products);
      expect(enArgs.products).toBe(frArgs.products);
      expect(frArgs.season).toBe("holidays");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets each language self-fetch images when the shared Unsplash fetch fails", async () => {
    const { route, generateBlogArticle } = await loadRoute({
      searchImages: vi.fn().mockRejectedValue(new Error("Unsplash down")),
    });

    const res = await route.GET(req(AUTH));

    expect(res.status).toBe(200);
    // No `images` key → the generator runs its own search per language.
    expect(generateBlogArticle.mock.calls[0][0].images).toBeUndefined();
    expect(generateBlogArticle.mock.calls[1][0].images).toBeUndefined();
  });

  it("still succeeds when only one language generates", async () => {
    const generateBlogArticle = vi
      .fn()
      .mockResolvedValueOnce(OK_ARTICLE)
      .mockRejectedValueOnce(new Error("Claude refused"));
    const { route, recordCronRun } = await loadRoute({ generateBlogArticle });

    const res = await route.GET(req(AUTH));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.generated).toBe(1);
    expect(recordCronRun).toHaveBeenCalledWith("blog", "success", undefined);
  });

  it("records each language's real cause in cron_runs when both fail", async () => {
    const generateBlogArticle = vi
      .fn()
      .mockRejectedValueOnce(new Error("Claude credit balance too low"))
      .mockRejectedValueOnce(new Error("Shopify blog article create failed: 422"));
    const { route, recordCronRun } = await loadRoute({ generateBlogArticle });

    const res = await route.GET(req(AUTH));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);

    // The regression this guards: the old route threw a bare "Both FR and EN blog
    // generations failed", so cron_runs.detail never showed why and the 401 hid for weeks.
    const [, status, detail] = recordCronRun.mock.calls[0];
    expect(status).toBe("error");
    expect(detail).toContain("FR: Claude credit balance too low");
    expect(detail).toContain("EN: Shopify blog article create failed: 422");
  });
});
