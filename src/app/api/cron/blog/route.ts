import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import {
  selectBilingualTopic,
  type Language,
} from "@/lib/blog-topics";
import { searchImages, triggerDownload, type UnsplashImage } from "@/lib/unsplash";
import { trackCron } from "@/lib/cron-tracking";

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

  // trackCron records the run (success/error) in cron_runs for the dashboard. The
  // work throws on total failure so it is logged as 'error'; the outer catch turns
  // that back into the same 500 response shape the route returned before.
  let articles: LangOutcome[] = [];
  let sharedCount = 0;
  try {
    const generated = await trackCron("blog", async () => {
      // One shared photo set for the whole pair → identical imagery FR + EN.
      const sharedImages = await fetchSharedImages(sel.imageQuery);
      sharedCount = sharedImages ? sharedImages.length : 0;
      console.log(`[CRON/blog] shared images: ${sharedImages ? sharedImages.length : "none (self-fetch)"}`);

      const fr = await generateBlog(origin, sel.fr, "fr", sel.keywordsFr, sharedImages);

      console.log(`[CRON/blog] Waiting ${BETWEEN_LANGS_DELAY_MS}ms before EN`);
      await new Promise((r) => setTimeout(r, BETWEEN_LANGS_DELAY_MS));

      const en = await generateBlog(origin, sel.en, "en", sel.keywordsEn, sharedImages);

      articles = [fr, en];
      const count = articles.filter((a) => a.success).length;
      console.log(`[CRON/blog] Complete — ${count}/2 articles created`);
      if (count === 0) throw new Error("Both FR and EN blog generations failed");
      return count;
    });

    return NextResponse.json(
      {
        success: true,
        week: sel.week,
        topicIndex: sel.idx,
        sharedImages: sharedCount,
        articles,
        generated,
        triggeredAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/blog] run failed:", msg);
    return NextResponse.json(
      {
        success: false,
        week: sel.week,
        topicIndex: sel.idx,
        sharedImages: sharedCount,
        articles,
        generated: articles.filter((a) => a.success).length,
        error: msg,
        triggeredAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
