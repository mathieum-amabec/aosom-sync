/**
 * POST /api/blog/generate
 *
 * Generate a bilingual-aware (~800-word) blog article using Claude,
 * pull 3 landscape photos from Unsplash (1 featured + 2 inline with
 * required attribution), and create the article as a draft in the
 * language-appropriate Shopify blog.
 *
 * Request body:
 *   { topic: string, lang: "fr" | "en", keywords?: string[] }
 *
 * Response:
 *   { articleId, adminUrl, title, blogId, handle, imagesUsed }
 */

import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/content-generator";
import { CLAUDE } from "@/lib/config";
import { searchImages, triggerDownload, type UnsplashImage } from "@/lib/unsplash";
import { createBlogArticle, type BlogLang } from "@/lib/shopify-blog";
import { checkRateLimit } from "@/lib/rate-limiter";

interface BlogGenerateBody {
  topic: string;
  lang: BlogLang;
  keywords?: string[];
}

interface ClaudeArticleJson {
  title: string;
  bodyHtml: string;
  excerpt: string;
  metaDescription: string;
  tags: string[];
}

function parseBody(raw: unknown): BlogGenerateBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Body must be a JSON object" };
  const obj = raw as Record<string, unknown>;

  const topic = typeof obj.topic === "string" ? obj.topic.trim() : "";
  if (!topic) return { error: "`topic` is required (non-empty string)" };
  if (topic.length > 200) return { error: "`topic` must be 200 chars or less" };

  const lang = obj.lang;
  if (lang !== "fr" && lang !== "en") {
    return { error: '`lang` must be "fr" or "en"' };
  }

  let keywords: string[] | undefined;
  if (obj.keywords !== undefined) {
    if (!Array.isArray(obj.keywords)) {
      return { error: "`keywords` must be an array of strings" };
    }
    keywords = obj.keywords
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  return { topic, lang, keywords };
}

function langPromptFragment(lang: BlogLang): string {
  return lang === "fr"
    ? "Write in natural Quebec French (not Parisian). Use Canadian spelling and idioms."
    : "Write in clear North American English suited to Canadian readers.";
}

const SYSTEM_PROMPT_BASE = `You are a bilingual e-commerce blog writer for Aosom Canada, a Quebec-based retailer of outdoor furniture, gazebos, garden beds, greenhouses, and home goods.

Rules:
- Output ONE JSON object — no markdown fences, no commentary.
- Title under 80 characters, descriptive and search-friendly.
- bodyHtml is 700-900 words of clean semantic HTML: <h2>, <h3>, <p>, <ul>, <li>. No <h1> (Shopify renders title separately). No inline styles, no <img> tags (images are inserted server-side), no <script>.
- Structure: short intro paragraph, 3-5 H2 sections with body paragraphs, brief conclusion.
- excerpt is 1-2 sentences (under 200 chars) used as the article summary.
- metaDescription is under 160 chars, SEO-friendly.
- tags is an array of 4-8 short topic tags (lowercase, no leading #).
- Do NOT mention pricing, shipping, or product SKUs (those change).
- Do NOT invent specific product names, model numbers, or claims you cannot back up.`;

function buildUserPrompt(input: BlogGenerateBody): string {
  const kw = input.keywords && input.keywords.length > 0
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

async function generateArticleJson(input: BlogGenerateBody): Promise<ClaudeArticleJson> {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: CLAUDE.MODEL,
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
  const bodyHtml = typeof p.bodyHtml === "string" ? p.bodyHtml : "";
  const excerpt = typeof p.excerpt === "string" ? p.excerpt.trim().slice(0, 300) : "";
  const metaDescription = typeof p.metaDescription === "string" ? p.metaDescription.trim().slice(0, 320) : "";
  const tags = Array.isArray(p.tags)
    ? p.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 12)
    : [];

  if (!title) throw new Error("Claude response missing `title`");
  if (!bodyHtml) throw new Error("Claude response missing `bodyHtml`");

  return { title, bodyHtml, excerpt, metaDescription, tags };
}

function escapeHtml(s: string): string {
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
 * Insert two inline figures into bodyHtml at roughly the 1/3 and 2/3
 * paragraph boundaries so they break up the text naturally.
 */
function injectInlineImages(
  bodyHtml: string,
  images: UnsplashImage[],
  lang: BlogLang,
): string {
  if (images.length === 0) return bodyHtml;
  // Split on closing block boundaries that mark natural pause points.
  // Keep delimiters so we can stitch back together unchanged.
  const parts = bodyHtml.split(/(<\/p>|<\/h2>|<\/h3>|<\/ul>|<\/ol>)/i);
  // Reassemble into "blocks" of (content + delimiter) pairs.
  const blocks: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i] ?? "";
    const delim = parts[i + 1] ?? "";
    if (content || delim) blocks.push(content + delim);
  }
  if (blocks.length < 3) {
    // Not enough structure — append both images at the end.
    return bodyHtml + images.map((img) => buildFigureHtml(img, lang)).join("");
  }
  const positions = images.length === 1
    ? [Math.floor(blocks.length / 2)]
    : [Math.floor(blocks.length / 3), Math.floor((blocks.length * 2) / 3)];

  // Inject in reverse so earlier insertion indices stay valid.
  const sorted = positions.map((pos, idx) => ({ pos, img: images[idx] })).sort((a, b) => b.pos - a.pos);
  for (const { pos, img } of sorted) {
    blocks.splice(pos, 0, buildFigureHtml(img, lang));
  }
  return blocks.join("");
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 6 generations per minute per process (room for retries
  // and bursts, hard cap before Anthropic billing escalates).
  const rl = checkRateLimit("blog-generate", 6, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const input = parsed;

  try {
    // 1. Generate article copy via Claude.
    const article = await generateArticleJson(input);

    // 2. Fetch 3 Unsplash photos: 1 featured + 2 inline.
    const searchQuery = [input.topic, ...(input.keywords ?? [])].filter(Boolean).join(" ");
    const images = await searchImages(searchQuery, 3);
    if (images.length < 3) {
      throw new Error(`Unsplash returned ${images.length} image(s) for "${searchQuery}", need 3`);
    }

    // 3. Trigger download notifications (Unsplash API guideline — required).
    //    Fire sequentially to respect API politeness; failures are logged
    //    inside triggerDownload and never block the article.
    for (const img of images) {
      await triggerDownload(img.downloadLocation);
    }

    // 4. Compose final body: 2 inline images injected into Claude's HTML.
    const featured = images[0];
    const inline = images.slice(1, 3);
    const finalBodyHtml = injectInlineImages(article.bodyHtml, inline, input.lang);

    // 5. Create the Shopify draft article in the right blog.
    const created = await createBlogArticle({
      title: article.title,
      bodyHtml: finalBodyHtml,
      lang: input.lang,
      featuredImage: { src: featured.url, alt: featured.altDescription },
      summaryHtml: `<p>${escapeHtml(article.excerpt)}</p>`,
      tags: article.tags,
      metaDescription: article.metaDescription,
    });

    return NextResponse.json({
      success: true,
      articleId: created.articleId,
      adminUrl: created.adminUrl,
      handle: created.handle,
      blogId: created.blogId,
      title: article.title,
      imagesUsed: images.map((i) => ({ id: i.id, photographer: i.photographer })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Avoid echoing full upstream payloads (Shopify/Claude/Unsplash) to the client.
    console.error("[/api/blog/generate] failed:", err);
    return NextResponse.json({ error: "Blog generation failed", detail: message }, { status: 500 });
  }
}
