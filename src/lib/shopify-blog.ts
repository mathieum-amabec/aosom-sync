/**
 * Shopify Online Store Blog Article API — create draft blog posts.
 *
 * Articles are always created with `published: false` so the Aosom team
 * can review them in the admin before they go live. The two target blogs
 * (`Actualités` FR, `Blog` EN) are configured in `config.ts` under `BLOG`.
 */

import { shopifyFetch } from "./shopify-client";
import { BLOG } from "./config";

export type BlogLang = "fr" | "en";

export interface CreateBlogArticleInput {
  /** Article title. */
  title: string;
  /** Body HTML — already includes inline images, headings, paragraphs. */
  bodyHtml: string;
  /** Target blog language. Maps to BLOG.FR_ID or BLOG.EN_ID. */
  lang: BlogLang;
  /** Optional featured image (Shopify pulls remote URLs into its CDN). */
  featuredImage?: { src: string; alt?: string };
  /** Optional short excerpt shown in blog listings. */
  summaryHtml?: string;
  /** Optional comma-joined tag list, or array. */
  tags?: string | string[];
  /** Author byline. Defaults to the store brand "Ameublo Direct" (public byline — never
   * the supplier name). */
  author?: string;
  /** SEO meta description (used as `metafields_global_description_tag`). */
  metaDescription?: string;
}

export interface CreatedBlogArticle {
  articleId: string;
  blogId: number;
  handle: string;
  adminUrl: string;
}

function blogIdFor(lang: BlogLang): number {
  return lang === "fr" ? BLOG.FR_ID : BLOG.EN_ID;
}

/**
 * Create a draft blog article in the language-appropriate Shopify blog.
 */
export async function createBlogArticle(
  input: CreateBlogArticleInput,
): Promise<CreatedBlogArticle> {
  if (!input.title.trim()) throw new Error("createBlogArticle: title required");
  if (!input.bodyHtml.trim()) throw new Error("createBlogArticle: bodyHtml required");

  const blogId = blogIdFor(input.lang);

  const tags =
    Array.isArray(input.tags) ? input.tags.join(", ") : input.tags ?? "";

  const article: Record<string, unknown> = {
    title: input.title.slice(0, 255),
    body_html: input.bodyHtml,
    author: input.author ?? "Ameublo Direct",
    tags,
    published: false,
  };

  if (input.summaryHtml) {
    article.summary_html = input.summaryHtml;
  }

  if (input.featuredImage?.src) {
    article.image = {
      src: input.featuredImage.src,
      alt: (input.featuredImage.alt ?? input.title).slice(0, 512),
    };
  }

  if (input.metaDescription) {
    article.metafields = [
      {
        namespace: "global",
        key: "description_tag",
        value: input.metaDescription.slice(0, 320),
        type: "single_line_text_field",
      },
    ];
  }

  const response = await shopifyFetch(`/blogs/${blogId}/articles.json`, {
    method: "POST",
    body: JSON.stringify({ article }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify blog article create failed: ${response.status} — ${text}`);
  }

  const data = (await response.json()) as { article: { id: number; handle: string } };
  const articleId = String(data.article.id);

  return {
    articleId,
    blogId,
    handle: data.article.handle,
    adminUrl: BLOG.ADMIN_ARTICLE_URL(articleId),
  };
}

/**
 * Flip an existing draft article live by setting `published: true`. Shopify stamps
 * `published_at` to now. Idempotent on Shopify's side — re-publishing an already-live
 * article is a no-op. Used by the blog auto-publisher once an article clears the quality
 * + season + weekly-cap gates.
 */
export async function publishBlogArticle(blogId: number, articleId: string): Promise<void> {
  const response = await shopifyFetch(`/blogs/${blogId}/articles/${articleId}.json`, {
    method: "PUT",
    body: JSON.stringify({ article: { id: Number(articleId), published: true } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify blog article publish failed: ${response.status} — ${text}`);
  }
}
