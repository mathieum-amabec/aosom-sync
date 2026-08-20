/**
 * Blog article generation — Claude copy → Unsplash photos → Shopify draft → auto-publish gate.
 *
 * This lives in `lib/` rather than inside the route on purpose. The blog cron used to reach
 * its own `/api/blog/generate` endpoint over HTTP (`fetch(${origin}/api/blog/generate)`),
 * which meant every run left the function, hit the Vercel edge, and came back. With Vercel
 * SSO Deployment Protection enabled (`all_except_custom_domains`) and no custom domain on the
 * project, that round-trip was answered with a **401 by the platform** before the route's own
 * CRON_SECRET check ever ran — so the cron failed 100% of the time for weeks while looking
 * perfectly healthy in `vercel.json`.
 *
 * Calling `generateBlogArticle()` in-process removes the hop entirely: no edge round-trip, no
 * protection surface, one function invocation instead of two, and the `/api/blog/generate`
 * rate limiter is no longer consumed by the cron's own traffic. The HTTP route is kept as a
 * thin wrapper for manual/admin generation.
 */

import { getAnthropicClient } from "./content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { CLAUDE } from "./config";
import { searchImages, triggerDownload, type UnsplashImage } from "./unsplash";
import { createBlogArticle, type BlogLang } from "./shopify-blog";
import { maybeAutoPublish } from "./blog-auto-publish";
import { recordBlogPost } from "./database";
import { type Season } from "./blog-topics";

export interface GenerateBlogInput {
  topic: string;
  lang: BlogLang;
  keywords?: string[];
  /** Pre-fetched shared photo set (from the bilingual cron) — when present the search and
   *  the download pings are skipped so the FR + EN pair stays visually identical. */
  images?: UnsplashImage[];
  /** Topic season — feeds the auto-publish season gate. Absent → treated as evergreen. */
  season?: Season;
  /** Opt in to the quality/season/cap auto-publish gate. The cron sets this true; manual
   *  calls default to draft-only. */
  autoPublish?: boolean;
}

export interface GeneratedBlogArticle {
  articleId: string;
  adminUrl: string;
  handle: string;
  blogId: number;
  title: string;
  imagesUsed: { id: string; photographer: string }[];
  score: number | null;
  published: boolean;
  publishReason: string;
}

interface ClaudeArticleJson {
  title: string;
  bodyHtml: string;
  excerpt: string;
  metaDescription: string;
  tags: string[];
}

/**
 * The store is **Ameublo Direct** (FR) / **Furnish Direct** (EN). It was named "Aosom Canada"
 * here until 2026-08-19, and the model dutifully wrote what it was told: two published
 * articles opened a paragraph with "Chez Aosom Canada, vous trouverez…". Aosom is the
 * SUPPLIER and is strictly forbidden in anything a customer can read, so the store identity
 * is stated correctly first and the prohibition repeated as a rule — the model cannot avoid
 * a name it has been handed as its own employer.
 */
const SYSTEM_PROMPT_BASE = `You are a bilingual e-commerce blog writer for Ameublo Direct (French) / Furnish Direct (English), a Quebec-based retailer of outdoor furniture, gazebos, garden beds, greenhouses, and home goods.

Rules:
- Output ONE JSON object — no markdown fences, no commentary.
- Title under 80 characters, descriptive and search-friendly.
- bodyHtml is 700-900 words of clean semantic HTML: <h2>, <h3>, <p>, <ul>, <li>. No <h1> (Shopify renders title separately). No inline styles, no <img> tags (images are inserted server-side), no <script>.
- Structure: short intro paragraph, 3-5 H2 sections with body paragraphs, brief conclusion.
- excerpt is 1-2 sentences (under 200 chars) used as the article summary.
- metaDescription is under 160 chars, SEO-friendly.
- tags is an array of 4-8 short topic tags (lowercase, no leading #).
- Do NOT mention pricing, shipping, or product SKUs (those change).
- Do NOT invent specific product names, model numbers, or claims you cannot back up.
- NEVER mention Aosom, HOMCOM, Outsunny, PawHut, Vinsetto, Qaba, Soozier, or any other supplier or manufacturer name. These are our suppliers, not our brand, and must never appear in customer-facing text.
- NEVER mention aosom-sync, or any internal tool, repository, or system name, anywhere — including URLs, UTM parameters, tags, and metadata.
- When you need to name the store, write "Ameublo Direct" in French and "Furnish Direct" in English. Never any other name.`;

function langPromptFragment(lang: BlogLang): string {
  return lang === "fr"
    ? "Write in natural Quebec French (not Parisian). Use Canadian spelling and idioms."
    : "Write in clear North American English suited to Canadian readers.";
}

function buildUserPrompt(input: GenerateBlogInput): string {
  const kw =
    input.keywords && input.keywords.length > 0
      ? `Target SEO keywords (weave naturally, do not stuff): ${input.keywords.join(", ")}.`
      : "No specific SEO keywords — focus on natural readability.";

  return `Write a blog article on this topic: "${input.topic}".

${langPromptFragment(input.lang)}
${kw}

Return JSON with this exact shape:
{
  "title": "...",
  "bodyHtml": "<p>...</p>...",
  "excerpt": "...",
  "metaDescription": "...",
  "tags": ["...", "..."]
}`;
}

export async function generateArticleJson(input: GenerateBlogInput): Promise<ClaudeArticleJson> {
  const client = getAnthropicClient();
  // Blog generation used to call client.messages.create() directly, which meant it was
  // neither gated by the daily spend cap nor recorded in daily_llm_budget — a hole in the
  // CSO guardrail that also made every consumption report undercount. Route it through
  // budgetedCreate like every other caller (default pool: "batch").
  const message = await budgetedCreate(client, {
    model: CLAUDE.MODEL_BATCH,
    max_tokens: CLAUDE.MAX_TOKENS_CONTENT,
    system: SYSTEM_PROMPT_BASE,
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  if (!message.content.length || message.content[0].type !== "text" || !message.content[0].text.trim()) {
    throw new Error("Claude returned empty or non-text content (possible refusal)");
  }

  const text = message.content[0].text;
  const jsonStr = text.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Claude returned invalid JSON: ${text.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude returned a non-object payload");
  }
  const p = parsed as Record<string, unknown>;

  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  // Defensive: even though the prompt forbids fences, the model sometimes wraps the HTML
  // *inside* the bodyHtml string in a ```html ... ``` fence. The outer JSON-fence strip above
  // does not reach inside the field, so those markers would render as literal "```html" text
  // on the published article. Strip any fence runs here.
  // Sanitize BEFORE the body goes anywhere else, so the quality judge scores exactly the
  // markup that will be published rather than a pre-strip version of it.
  const bodyHtml =
    typeof p.bodyHtml === "string"
      ? sanitizeArticleHtml(
          p.bodyHtml
            // Drop a fence opener sitting on its own line (and its ```html lang tag).
            // Anchoring to a real line break avoids eating a word right after an inline
            // backtick run.
            .replace(/```+[a-zA-Z]*[ \t]*\r?\n/g, "")
            // Remove any remaining bare backtick run (the trailing closing fence, strays).
            .replace(/```+/g, ""),
        ).trim()
      : "";
  const excerpt = typeof p.excerpt === "string" ? p.excerpt.trim().slice(0, 300) : "";
  const metaDescription =
    typeof p.metaDescription === "string" ? p.metaDescription.trim().slice(0, 320) : "";
  const tags = Array.isArray(p.tags)
    ? p.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 12)
    : [];

  if (!title) throw new Error("Claude response missing `title`");
  if (!bodyHtml) throw new Error("Claude response missing `bodyHtml`");

  return { title, bodyHtml, excerpt, metaDescription, tags };
}

/**
 * Strip executable markup from model-generated HTML before it is stored on a public
 * storefront article.
 *
 * The system prompt already forbids `<script>` and inline styles, but a prompt is a request,
 * not a guarantee — and this HTML is rendered verbatim to every visitor on ameublodirect.ca,
 * so a single stray tag would be stored XSS. In normal operation this function is a no-op
 * (the model complies); it exists so that "no script tags" is enforced by code rather than
 * by the model's goodwill.
 *
 * Deliberately a denylist of executable vectors, not a general HTML sanitizer: the body is
 * meant to keep its semantic markup (h2/p/ul/figure), so stripping to a tag allowlist would
 * destroy legitimate content. Inputs are repo-controlled topic strings, not user input.
 */
export function sanitizeArticleHtml(html: string): string {
  return html
    // Executable / embedding elements, including their contents.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    // Unclosed/self-closing variants of the same elements.
    .replace(/<\/?(script|style|iframe|object|embed|form)\b[^>]*>/gi, "")
    // Inline event handlers: onclick="…", onerror='…', onload=… (unquoted).
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    // javascript:/data: URLs in href/src.
    .replace(/\s(href|src)\s*=\s*"\s*(?:javascript|data)\s*:[^"]*"/gi, "")
    .replace(/\s(href|src)\s*=\s*'\s*(?:javascript|data)\s*:[^']*'/gi, "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildFigureHtml(img: UnsplashImage, lang: BlogLang): string {
  const credit = lang === "fr" ? "Photo par" : "Photo by";
  const onWord = lang === "fr" ? "sur" : "on";
  return [
    "<figure>",
    `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.altDescription)}" loading="lazy" />`,
    "<figcaption>",
    `${credit} <a href="${escapeHtml(img.photographerUrl)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(img.photographer)}</a> ${onWord} <a href="${escapeHtml(img.unsplashUrl)}" rel="noopener noreferrer nofollow" target="_blank">Unsplash</a>`,
    "</figcaption>",
    "</figure>",
  ].join("");
}

/**
 * Insert inline figures into bodyHtml at roughly the 1/3 and 2/3 paragraph boundaries so
 * they break up the text naturally.
 */
export function injectInlineImages(
  bodyHtml: string,
  images: UnsplashImage[],
  lang: BlogLang,
): string {
  if (images.length === 0) return bodyHtml;
  // Split on closing block boundaries that mark natural pause points. Keep the delimiters so
  // the document can be stitched back together unchanged.
  const parts = bodyHtml.split(/(<\/p>|<\/h2>|<\/h3>|<\/ul>|<\/ol>)/i);
  const blocks: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i] ?? "";
    const delim = parts[i + 1] ?? "";
    if (content || delim) blocks.push(content + delim);
  }
  if (blocks.length < 3) {
    // Not enough structure — append the images at the end.
    return bodyHtml + images.map((img) => buildFigureHtml(img, lang)).join("");
  }
  const positions =
    images.length === 1
      ? [Math.floor(blocks.length / 2)]
      : [Math.floor(blocks.length / 3), Math.floor((blocks.length * 2) / 3)];

  // Inject in reverse so earlier insertion indices stay valid.
  const sorted = positions.map((pos, idx) => ({ pos, img: images[idx] })).sort((a, b) => b.pos - a.pos);
  for (const { pos, img } of sorted) {
    blocks.splice(pos, 0, buildFigureHtml(img, lang));
  }
  return blocks.join("");
}

/**
 * Generate one article end-to-end and create it in the language-appropriate Shopify blog.
 *
 * Throws on any failure that leaves no article behind (Claude refusal/invalid JSON, Unsplash
 * shortfall, Shopify rejection); the caller decides how to surface it. Every outcome —
 * success or failure — is logged to `blog_posts` so the /blog dashboard shows what happened
 * instead of silence.
 */
export async function generateBlogArticle(
  input: GenerateBlogInput,
): Promise<GeneratedBlogArticle> {
  let article: ClaudeArticleJson | undefined;
  try {
    // 1. Article copy from Claude.
    article = await generateArticleJson(input);

    // 2. Use the caller-supplied shared photo set when present (keeps the FR + EN pair
    //    identical); otherwise search Unsplash for this topic.
    let images: UnsplashImage[];
    if (input.images && input.images.length >= 3) {
      // Download pings already fired by whoever fetched the shared set.
      images = input.images;
    } else {
      const searchQuery = [input.topic, ...(input.keywords ?? [])].filter(Boolean).join(" ");
      images = await searchImages(searchQuery, 3);
      if (images.length < 3) {
        throw new Error(`Unsplash returned ${images.length} image(s) for "${searchQuery}", need 3`);
      }
      // Unsplash API guideline — required whenever a photo is used. Failures are logged
      // inside triggerDownload and never block the article.
      for (const img of images) {
        await triggerDownload(img.downloadLocation);
      }
    }

    // 3. Compose the final body: 2 inline images injected into Claude's HTML.
    const featured = images[0];
    const inline = images.slice(1, 3);
    const finalBodyHtml = injectInlineImages(article.bodyHtml, inline, input.lang);

    // 4. Create the Shopify draft article in the right blog.
    const created = await createBlogArticle({
      title: article.title,
      bodyHtml: finalBodyHtml,
      lang: input.lang,
      featuredImage: { src: featured.url, alt: featured.altDescription },
      summaryHtml: `<p>${escapeHtml(article.excerpt)}</p>`,
      tags: article.tags,
      metaDescription: article.metaDescription,
    });

    // 5. Auto-publish gate (opt-in). The article exists as a draft either way; this only
    //    flips it live when it clears quality AND season AND the weekly cap.
    const { published, score, publishReason } = await maybeAutoPublish({
      autoPublish: input.autoPublish ?? false,
      lang: input.lang,
      season: input.season,
      article,
      blogId: created.blogId,
      articleId: created.articleId,
    });

    await recordBlogPost({
      title: article.title,
      lang: input.lang,
      status: published ? "published" : "draft",
      shopifyArticleId: created.articleId,
    });

    return {
      articleId: created.articleId,
      adminUrl: created.adminUrl,
      handle: created.handle,
      blogId: created.blogId,
      title: article.title,
      imagesUsed: images.map((i) => ({ id: i.id, photographer: i.photographer })),
      score,
      published,
      publishReason,
    };
  } catch (err) {
    // Log the failure against the article title when Claude got far enough to produce one,
    // otherwise against the requested topic — either way the dashboard shows the attempt.
    await recordBlogPost({
      title: article?.title ?? input.topic,
      lang: input.lang,
      status: "failed",
      shopifyArticleId: null,
    });
    throw err;
  }
}
