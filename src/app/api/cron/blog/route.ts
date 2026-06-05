import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import {
  selectBilingualTopic,
  type Language,
} from "@/lib/blog-topics";
import { searchImages, triggerDownload, type UnsplashImage } from "@/lib/unsplash";

// Two sequential blog generations (Claude article + Shopify draft create),
// each ~30-50s, plus one shared Unsplash fetch, with a 3s pause between langs.
export const maxDuration = 180;

// Spacing between FR and EN generations — stays well inside the blog/generate
// rate limiter (6/min) and gives Claude a beat.
const BETWEEN_LANGS_DELAY_MS = 3_000;

// Images shared across the FR + EN pair so the two articles are visually
// identical. One photo set per run keeps Unsplash usage and download pings low.
const SHARED_IMAGE_COUNT = 3;

type LangOutcome =
  | { language: Language; success: true; articleId: string; adminUrl: string; title: string }
  | { language: Language; success: false; error: string };

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

interface BlogGenerateResponse {
  success: true;
  articleId: string;
  adminUrl: string;
  title: string;
  handle: string;
  blogId: number;
}

/**
 * Fetch the photo set shared by both languages. Returns `undefined` (not an
 * error) when Unsplash fails — callers then let each language self-fetch so a
 * photo hiccup never blocks the articles, at the cost of the "same image"
 * guarantee for that one run.
 */
async function fetchSharedImages(query: string): Promise<UnsplashImage[] | undefined> {
  try {
    const images = await searchImages(query, SHARED_IMAGE_COUNT);
    if (images.length < SHARED_IMAGE_COUNT) {
      console.error(`[CRON/blog] shared image query "${query}" returned ${images.length}/${SHARED_IMAGE_COUNT}; langs will self-fetch`);
      return undefined;
    }
    // Trigger download pings once here (Unsplash guideline) since /api/blog/generate
    // skips its own search + ping when images are supplied.
    for (const img of images) {
      await triggerDownload(img.downloadLocation);
    }
    return images;
  } catch (err) {
    console.error(`[CRON/blog] shared image fetch failed for "${query}"; langs will self-fetch:`, err);
    return undefined;
  }
}

async function generateBlog(
  origin: string,
  topic: string,
  lang: Language,
  keywords: string[],
  images: UnsplashImage[] | undefined,
): Promise<LangOutcome> {
  const url = `${origin}/api/blog/generate`;
  const tag = lang.toUpperCase();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.cronSecret}`,
        "Content-Type": "application/json",
      },
      // `images` is omitted when undefined → generate falls back to its own search.
      body: JSON.stringify({ topic, lang, keywords, ...(images ? { images } : {}) }),
    });
  } catch (err) {
    console.error(`[CRON/blog] ${tag} fetch threw:`, err);
    return { language: lang, success: false, error: "Generate endpoint unreachable" };
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[CRON/blog] ${tag} generation failed (HTTP ${res.status}):`, text);
    return { language: lang, success: false, error: `Generation failed (HTTP ${res.status})` };
  }

  const result = (await res.json()) as BlogGenerateResponse;
  console.log(`[CRON/blog] ${tag} article created: ${result.articleId} (${result.title})`);
  return {
    language: lang,
    success: true,
    articleId: result.articleId,
    adminUrl: result.adminUrl,
    title: result.title,
  };
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const sel = selectBilingualTopic(new Date());
  const origin = new URL(request.url).origin;

  console.log(`[CRON/blog] week=${sel.week} idx=${sel.idx} FR="${sel.fr}" EN="${sel.en}" img="${sel.imageQuery}"`);

  // One shared photo set for the whole pair → identical imagery FR + EN.
  const sharedImages = await fetchSharedImages(sel.imageQuery);
  console.log(`[CRON/blog] shared images: ${sharedImages ? sharedImages.length : "none (self-fetch)"}`);

  const fr = await generateBlog(origin, sel.fr, "fr", sel.keywordsFr, sharedImages);

  console.log(`[CRON/blog] Waiting ${BETWEEN_LANGS_DELAY_MS}ms before EN`);
  await new Promise((r) => setTimeout(r, BETWEEN_LANGS_DELAY_MS));

  const en = await generateBlog(origin, sel.en, "en", sel.keywordsEn, sharedImages);

  const articles: LangOutcome[] = [fr, en];
  const generated = articles.filter((a) => a.success).length;
  console.log(`[CRON/blog] Complete — ${generated}/2 articles created`);

  const allFailed = generated === 0;
  return NextResponse.json(
    {
      success: !allFailed,
      week: sel.week,
      topicIndex: sel.idx,
      sharedImages: sharedImages ? sharedImages.length : 0,
      articles,
      generated,
      triggeredAt: new Date().toISOString(),
    },
    { status: allFailed ? 500 : 200 },
  );
}
