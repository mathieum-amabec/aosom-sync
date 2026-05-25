/**
 * Test script: generate 1 FR + 1 EN draft blog article end-to-end by
 * invoking the same orchestration the API route uses, but bypassing
 * Next.js HTTP so it can be run directly with `bun run`.
 *
 * Usage:
 *   bun run src/scripts/test-blog-generation.ts
 *
 * Env: reads .env.local (Bun loads this automatically when run from the
 * project root). Requires ANTHROPIC_API_KEY, SHOPIFY_ACCESS_TOKEN, and
 * UNSPLASH_ACCESS_KEY.
 *
 * Output: prints two admin URLs the user can open in Shopify to review
 * the generated drafts. Exits non-zero on any failure.
 *
 * Spaces Claude calls 2s apart (the rate-limit window the route uses
 * is 6/min — this stays well inside it but matches the spec's intent).
 */

import { getAnthropicClient } from "@/lib/content-generator";
import { CLAUDE } from "@/lib/config";
import { searchImages, triggerDownload, type UnsplashImage } from "@/lib/unsplash";
import { createBlogArticle, type BlogLang } from "@/lib/shopify-blog";

const SYSTEM_PROMPT = `You are a bilingual e-commerce blog writer for Aosom Canada, a Quebec-based retailer of outdoor furniture, gazebos, garden beds, greenhouses, and home goods.

Rules:
- Output ONE JSON object — no markdown fences, no commentary.
- Title under 80 characters.
- bodyHtml is 700-900 words of clean semantic HTML: <h2>, <h3>, <p>, <ul>, <li>. No <h1>, no inline styles, no <img> tags, no <script>.
- Structure: short intro paragraph, 3-5 H2 sections, brief conclusion.
- excerpt is 1-2 sentences (under 200 chars).
- metaDescription is under 160 chars.
- tags is 4-8 short lowercase topic tags.
- Do NOT mention pricing, shipping, or product SKUs.`;

interface ArticleJson {
  title: string;
  bodyHtml: string;
  excerpt: string;
  metaDescription: string;
  tags: string[];
}

function langFragment(lang: BlogLang): string {
  return lang === "fr"
    ? "Write in natural Quebec French (not Parisian). Use Canadian spelling and idioms."
    : "Write in clear North American English suited to Canadian readers.";
}

async function generateJson(topic: string, lang: BlogLang, keywords: string[]): Promise<ArticleJson> {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: CLAUDE.MODEL,
    max_tokens: CLAUDE.MAX_TOKENS_CONTENT,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Write a blog article on this topic: "${topic}".

${langFragment(lang)}
SEO keywords to weave naturally: ${keywords.join(", ")}.

Return JSON with this exact shape:
{
  "title": "...",
  "bodyHtml": "<p>...</p>...",
  "excerpt": "...",
  "metaDescription": "...",
  "tags": ["...", "..."]
}`,
      },
    ],
  });

  if (!message.content.length || message.content[0].type !== "text") {
    throw new Error("Claude returned empty content");
  }
  const text = message.content[0].text;
  const jsonStr = text.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  const parsed = JSON.parse(jsonStr) as Partial<ArticleJson>;
  if (!parsed.title || !parsed.bodyHtml) throw new Error("Claude JSON missing title or bodyHtml");
  return {
    title: parsed.title,
    bodyHtml: parsed.bodyHtml,
    excerpt: parsed.excerpt ?? "",
    metaDescription: parsed.metaDescription ?? "",
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function figure(img: UnsplashImage, lang: BlogLang): string {
  const credit = lang === "fr" ? "Photo par" : "Photo by";
  const onWord = lang === "fr" ? "sur" : "on";
  return `<figure><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.altDescription)}" loading="lazy" /><figcaption>${credit} <a href="${escapeHtml(img.photographerUrl)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(img.photographer)}</a> ${onWord} <a href="${escapeHtml(img.unsplashUrl)}" rel="noopener noreferrer nofollow" target="_blank">Unsplash</a></figcaption></figure>`;
}

function injectInline(bodyHtml: string, images: UnsplashImage[], lang: BlogLang): string {
  if (images.length === 0) return bodyHtml;
  const parts = bodyHtml.split(/(<\/p>|<\/h2>|<\/h3>|<\/ul>|<\/ol>)/i);
  const blocks: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i] ?? "";
    const delim = parts[i + 1] ?? "";
    if (content || delim) blocks.push(content + delim);
  }
  if (blocks.length < 3) {
    return bodyHtml + images.map((img) => figure(img, lang)).join("");
  }
  const positions = images.length === 1
    ? [Math.floor(blocks.length / 2)]
    : [Math.floor(blocks.length / 3), Math.floor((blocks.length * 2) / 3)];
  const sorted = positions.map((pos, idx) => ({ pos, img: images[idx] })).sort((a, b) => b.pos - a.pos);
  for (const { pos, img } of sorted) {
    blocks.splice(pos, 0, figure(img, lang));
  }
  return blocks.join("");
}

const HAS_UNSPLASH = !!process.env.UNSPLASH_ACCESS_KEY;

async function generateOne(topic: string, lang: BlogLang, keywords: string[]) {
  console.log(`\n=== [${lang.toUpperCase()}] ${topic} ===`);
  console.log("  1/4 Generating article via Claude...");
  const article = await generateJson(topic, lang, keywords);
  console.log(`      title: ${article.title}`);
  console.log(`      body: ${article.bodyHtml.length} chars`);

  let images: UnsplashImage[] = [];
  if (HAS_UNSPLASH) {
    console.log("  2/4 Searching Unsplash (3 images)...");
    const query = [topic, ...keywords].filter(Boolean).join(" ");
    images = await searchImages(query, 3);
    console.log(`      got ${images.length} photos: ${images.map((i) => i.photographer).join(", ")}`);

    console.log("  3/4 Triggering Unsplash downloads...");
    for (const img of images) {
      await triggerDownload(img.downloadLocation);
      await sleep(2000);
    }
  } else {
    console.log("  2/4 SKIPPED — UNSPLASH_ACCESS_KEY missing. Creating image-less draft.");
    console.log("  3/4 SKIPPED — no images to track.");
  }

  console.log("  4/4 Creating Shopify draft article...");
  const titlePrefix = HAS_UNSPLASH ? "" : (lang === "fr" ? "[TEST sans images] " : "[TEST no images] ");
  const finalTitle = (titlePrefix + article.title).slice(0, 255);
  const featured = images[0];
  const inlineImgs = images.slice(1, 3);
  const finalBody = images.length > 0
    ? injectInline(article.bodyHtml, inlineImgs, lang)
    : article.bodyHtml;
  const created = await createBlogArticle({
    title: finalTitle,
    bodyHtml: finalBody,
    lang,
    featuredImage: featured ? { src: featured.url, alt: featured.altDescription } : undefined,
    summaryHtml: `<p>${escapeHtml(article.excerpt)}</p>`,
    tags: article.tags,
    metaDescription: article.metaDescription,
  });
  console.log(`      ✓ article #${created.articleId} (handle: ${created.handle})`);
  console.log(`      admin: ${created.adminUrl}`);
  return created;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results: { lang: BlogLang; adminUrl: string; title: string; articleId: string }[] = [];

  const fr = await generateOne(
    "Aménager un jardin urbain avec des bacs surélevés",
    "fr",
    ["bac surélevé", "jardin urbain", "potager balcon"],
  );
  results.push({ lang: "fr", ...fr, title: "FR article" });

  // 2s spacing between Claude calls per spec.
  await sleep(2000);

  const en = await generateOne(
    "Choosing the right gazebo for a Canadian backyard",
    "en",
    ["gazebo", "outdoor canopy", "backyard"],
  );
  results.push({ lang: "en", ...en, title: "EN article" });

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`  ${r.lang.toUpperCase()}: ${r.adminUrl}`);
  }
}

main().catch((err) => {
  console.error("\nTest FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
