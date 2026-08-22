import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers lib/blog-generator.ts — the in-process generation path the blog cron now calls
// directly instead of self-fetching /api/blog/generate over HTTP (that round-trip was being
// 401'd by Vercel SSO Deployment Protection before the app's own auth ran).

const IMG = (id: string) => ({
  id,
  url: `https://images.example/${id}.jpg`,
  altDescription: `alt ${id}`,
  photographer: `Photographer ${id}`,
  photographerUrl: `https://unsplash.example/@${id}`,
  unsplashUrl: "https://unsplash.example/",
  downloadLocation: `https://api.unsplash.example/photos/${id}/download`,
});

const THREE_IMAGES = [IMG("a"), IMG("b"), IMG("c")];

const ARTICLE_JSON = {
  title: "Aménager un petit salon",
  bodyHtml: "<p>Intro.</p><h2>Un</h2><p>Un corps.</p><h2>Deux</h2><p>Deux corps.</p><p>Conclusion.</p>",
  excerpt: "Un court résumé.",
  metaDescription: "Meta description SEO.",
  tags: ["salon", "petit espace"],
};

function claudeReturning(payload: unknown) {
  return {
    getAnthropicClient: () => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
        }),
      },
    }),
  };
}

interface MockOverrides {
  claude?: unknown;
  searchImages?: ReturnType<typeof vi.fn>;
  triggerDownload?: ReturnType<typeof vi.fn>;
  createBlogArticle?: ReturnType<typeof vi.fn>;
  maybeAutoPublish?: ReturnType<typeof vi.fn>;
  recordBlogPost?: ReturnType<typeof vi.fn>;
}

async function loadGenerator(o: MockOverrides = {}) {
  const searchImages = o.searchImages ?? vi.fn().mockResolvedValue(THREE_IMAGES);
  const triggerDownload = o.triggerDownload ?? vi.fn().mockResolvedValue(undefined);
  const createBlogArticle =
    o.createBlogArticle ??
    vi.fn().mockResolvedValue({
      articleId: "999",
      blogId: 90302349417,
      handle: "amenager-un-petit-salon",
      adminUrl: "https://admin.example/articles/999",
    });
  const maybeAutoPublish =
    o.maybeAutoPublish ??
    vi.fn().mockResolvedValue({ published: false, score: 72, publishReason: "score 72 < 80" });
  const recordBlogPost = o.recordBlogPost ?? vi.fn().mockResolvedValue(1);

  vi.doMock("@/lib/content-generator", () => (o.claude ?? claudeReturning(ARTICLE_JSON)) as object);
  vi.doMock("@/lib/unsplash", () => ({ searchImages, triggerDownload }));
  vi.doMock("@/lib/shopify-blog", () => ({ createBlogArticle }));
  vi.doMock("@/lib/blog-auto-publish", () => ({ maybeAutoPublish }));
  vi.doMock("@/lib/database", () => ({ recordBlogPost }));

  const mod = await import("@/lib/blog-generator");
  return { mod, searchImages, triggerDownload, createBlogArticle, maybeAutoPublish, recordBlogPost };
}

describe("generateBlogArticle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates the Shopify article and logs a 'draft' row when the publish gate declines", async () => {
    const { mod, createBlogArticle, recordBlogPost } = await loadGenerator();

    const result = await mod.generateBlogArticle({ topic: "Petit salon", lang: "fr", autoPublish: true });

    expect(result.articleId).toBe("999");
    expect(result.title).toBe(ARTICLE_JSON.title);
    expect(result.published).toBe(false);
    expect(result.score).toBe(72);

    expect(createBlogArticle).toHaveBeenCalledTimes(1);
    const created = createBlogArticle.mock.calls[0][0];
    expect(created.lang).toBe("fr");
    expect(created.metaDescription).toBe(ARTICLE_JSON.metaDescription);
    expect(created.tags).toEqual(ARTICLE_JSON.tags);

    expect(recordBlogPost).toHaveBeenCalledWith({
      title: ARTICLE_JSON.title,
      lang: "fr",
      status: "draft",
      shopifyArticleId: "999",
    });
  });

  it("logs a 'published' row when the auto-publish gate flips the article live", async () => {
    const { mod, recordBlogPost } = await loadGenerator({
      maybeAutoPublish: vi.fn().mockResolvedValue({ published: true, score: 88, publishReason: "published (score 88)" }),
    });

    const result = await mod.generateBlogArticle({ topic: "Petit salon", lang: "en", autoPublish: true });

    expect(result.published).toBe(true);
    expect(recordBlogPost).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published", lang: "en", shopifyArticleId: "999" }),
    );
  });

  it("reuses caller-supplied images without searching Unsplash or re-pinging downloads", async () => {
    const { mod, searchImages, triggerDownload, createBlogArticle } = await loadGenerator();

    await mod.generateBlogArticle({
      topic: "Petit salon",
      lang: "fr",
      images: THREE_IMAGES,
    });

    expect(searchImages).not.toHaveBeenCalled();
    expect(triggerDownload).not.toHaveBeenCalled();
    // The featured image is the first of the supplied set.
    expect(createBlogArticle.mock.calls[0][0].featuredImage.src).toBe(THREE_IMAGES[0].url);
  });

  it("searches Unsplash and fires one download ping per image when none are supplied", async () => {
    const { mod, searchImages, triggerDownload } = await loadGenerator();

    await mod.generateBlogArticle({ topic: "Petit salon", lang: "fr", keywords: ["deco"] });

    expect(searchImages).toHaveBeenCalledWith("Petit salon deco", 3);
    expect(triggerDownload).toHaveBeenCalledTimes(3);
  });

  it("records a 'failed' row and rethrows when Claude returns unusable content", async () => {
    const { mod, recordBlogPost, createBlogArticle } = await loadGenerator({
      claude: claudeReturning("not json at all"),
    });

    await expect(
      mod.generateBlogArticle({ topic: "Sujet raté", lang: "fr" }),
    ).rejects.toThrow(/Claude returned invalid JSON/);

    expect(createBlogArticle).not.toHaveBeenCalled();
    // No article title exists yet — the row is logged against the requested topic.
    expect(recordBlogPost).toHaveBeenCalledWith({
      title: "Sujet raté",
      lang: "fr",
      status: "failed",
      shopifyArticleId: null,
    });
  });

  it("records a 'failed' row under the article title when Shopify rejects the create", async () => {
    const { mod, recordBlogPost } = await loadGenerator({
      createBlogArticle: vi.fn().mockRejectedValue(new Error("Shopify blog article create failed: 422")),
    });

    await expect(mod.generateBlogArticle({ topic: "Petit salon", lang: "fr" })).rejects.toThrow(/Shopify/);

    expect(recordBlogPost).toHaveBeenCalledWith({
      title: ARTICLE_JSON.title,
      lang: "fr",
      status: "failed",
      shopifyArticleId: null,
    });
  });

  it("throws when Unsplash cannot supply the 3 required images", async () => {
    const { mod } = await loadGenerator({
      searchImages: vi.fn().mockResolvedValue([IMG("a")]),
    });

    await expect(mod.generateBlogArticle({ topic: "Petit salon", lang: "fr" })).rejects.toThrow(
      /Unsplash returned 1 image\(s\)/,
    );
  });

  it("strips stray markdown fences the model leaves inside bodyHtml", async () => {
    const { mod, createBlogArticle } = await loadGenerator({
      claude: claudeReturning({
        ...ARTICLE_JSON,
        bodyHtml: "```html\n<p>Intro.</p><h2>Un</h2><p>Corps.</p><p>Fin.</p>\n```",
      }),
    });

    await mod.generateBlogArticle({ topic: "Petit salon", lang: "fr" });

    const body = createBlogArticle.mock.calls[0][0].bodyHtml;
    expect(body).not.toContain("```");
    expect(body).toContain("<p>Intro.</p>");
  });
});

describe("injectInlineImages", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("inserts the figures between blocks and keeps the original markup intact", async () => {
    const { mod } = await loadGenerator();
    const body = "<p>A</p><p>B</p><p>C</p><p>D</p><p>E</p><p>F</p>";

    const out = mod.injectInlineImages(body, [THREE_IMAGES[1], THREE_IMAGES[2]], "fr");

    expect((out.match(/<figure>/g) ?? []).length).toBe(2);
    // Every original paragraph survives.
    for (const letter of ["A", "B", "C", "D", "E", "F"]) {
      expect(out).toContain(`<p>${letter}</p>`);
    }
    // French attribution wording.
    expect(out).toContain("Photo par");
    expect(out).toContain("Unsplash");
  });

  it("appends figures at the end when the body has too little structure", async () => {
    const { mod } = await loadGenerator();
    const body = "<p>Only one block</p>";

    const out = mod.injectInlineImages(body, [THREE_IMAGES[1], THREE_IMAGES[2]], "en");

    expect(out.startsWith("<p>Only one block</p>")).toBe(true);
    expect((out.match(/<figure>/g) ?? []).length).toBe(2);
    expect(out).toContain("Photo by");
  });

  it("returns the body untouched when there are no images", async () => {
    const { mod } = await loadGenerator();
    const body = "<p>A</p><p>B</p>";
    expect(mod.injectInlineImages(body, [], "fr")).toBe(body);
  });

  it("escapes attacker-controlled photo metadata into the figure markup", async () => {
    const { mod } = await loadGenerator();
    const evil = { ...IMG("x"), photographer: '"><script>alert(1)</script>' };

    const out = mod.injectInlineImages("<p>A</p><p>B</p><p>C</p>", [evil], "fr");

    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("sanitizeArticleHtml", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("strips script tags and their contents", async () => {
    const { mod } = await loadGenerator();
    const out = mod.sanitizeArticleHtml('<p>A</p><script>steal(document.cookie)</script><p>B</p>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("steal");
    expect(out).toBe("<p>A</p><p>B</p>");
  });

  it("strips iframe, object, embed, form and style blocks", async () => {
    const { mod } = await loadGenerator();
    const out = mod.sanitizeArticleHtml(
      '<p>A</p><iframe src="evil"></iframe><style>body{display:none}</style><form action="x"></form>',
    );
    expect(out).toBe("<p>A</p>");
  });

  it("strips inline event handlers in quoted and unquoted forms", async () => {
    const { mod } = await loadGenerator();
    expect(mod.sanitizeArticleHtml('<p onclick="evil()">A</p>')).toBe("<p>A</p>");
    expect(mod.sanitizeArticleHtml("<p onerror='evil()'>A</p>")).toBe("<p>A</p>");
    expect(mod.sanitizeArticleHtml("<img onload=evil() />")).toBe("<img />");
  });

  it("strips javascript: and data: URLs from href/src", async () => {
    const { mod } = await loadGenerator();
    expect(mod.sanitizeArticleHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(mod.sanitizeArticleHtml('<img src="data:text/html;base64,PHN2Zz4=" />')).toBe("<img />");
  });

  it("leaves legitimate semantic markup untouched", async () => {
    const { mod } = await loadGenerator();
    const clean = '<p>Intro.</p><h2>Titre</h2><ul><li>Un</li></ul><a href="https://ok.example">lien</a>';
    expect(mod.sanitizeArticleHtml(clean)).toBe(clean);
  });

  it("sanitizes the body before it reaches Shopify", async () => {
    const { mod, createBlogArticle } = await loadGenerator({
      claude: claudeReturning({
        ...ARTICLE_JSON,
        bodyHtml: '<p>Intro.</p><script>evil()</script><h2>Un</h2><p>Corps.</p><p>Fin.</p>',
      }),
    });

    await mod.generateBlogArticle({ topic: "Petit salon", lang: "fr" });

    const body = createBlogArticle.mock.calls[0][0].bodyHtml;
    expect(body).not.toContain("script");
    expect(body).not.toContain("evil");
    expect(body).toContain("<h2>Un</h2>");
  });
});
