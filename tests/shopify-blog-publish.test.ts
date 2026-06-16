import { describe, it, expect, vi, beforeEach } from "vitest";

const shopifyFetch = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: (...args: unknown[]) => shopifyFetch(...args) }));
vi.mock("@/lib/config", () => ({
  BLOG: { FR_ID: 1, EN_ID: 2, ADMIN_ARTICLE_URL: (id: string) => `admin/${id}` },
}));

import { publishBlogArticle } from "@/lib/shopify-blog";

beforeEach(() => vi.clearAllMocks());

describe("publishBlogArticle", () => {
  it("PUTs the article with published:true to the right endpoint", async () => {
    shopifyFetch.mockResolvedValueOnce({ ok: true });
    await publishBlogArticle(90302349417, "555");
    expect(shopifyFetch).toHaveBeenCalledTimes(1);
    const [endpoint, opts] = shopifyFetch.mock.calls[0];
    expect(endpoint).toBe("/blogs/90302349417/articles/555.json");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ article: { id: 555, published: true } });
  });

  it("throws with the Shopify status + body on a non-ok response", async () => {
    shopifyFetch.mockResolvedValueOnce({ ok: false, status: 422, text: async () => "bad article" });
    await expect(publishBlogArticle(1, "9")).rejects.toThrow(/publish failed: 422 — bad article/i);
  });
});
