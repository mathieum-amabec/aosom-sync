/**
 * GET /api/cron/blog — weekly bilingual blog generation (Vercel Cron, Mon + Thu 08:00 UTC).
 *
 * **GET, not POST, on purpose:** Vercel Cron only ever issues GET requests. A POST handler
 * here would never fire.
 *
 * Generation runs **in-process** via `generateBlogArticle()`. This route used to `fetch()`
 * its own `/api/blog/generate` endpoint; with Vercel SSO Deployment Protection on and no
 * custom domain, the platform answered that self-call with a 401 before the app's own
 * CRON_SECRET check ran, so every run failed. See lib/blog-generator.ts for the full note.
 */

import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import {
  selectBilingualTopic,
  type Language,
  type Season,
} from "@/lib/blog-topics";
import { searchImages, triggerDownload, type UnsplashImage } from "@/lib/unsplash";
import { generateBlogArticle } from "@/lib/blog-generator";
import { trackCron } from "@/lib/cron-tracking";

// Two sequential blog generations (Claude article + judge + Shopify create), each ~30-50s,
// plus one shared Unsplash fetch and a short pause between languages.
export const maxDuration = 180;

// Spacing between FR and EN generations — gives Claude a beat between two large calls.
const BETWEEN_LANGS_DELAY_MS = 3_000;

// Images shared across the FR + EN pair so the two articles are visually identical. One photo
// set per run keeps Unsplash usage and download pings low.
const SHARED_IMAGE_COUNT = 3;

type LangOutcome =
  | {
      language: Language;
      success: true;
      articleId: string;
      adminUrl: string;
      title: string;
      published: boolean;
      score: number | null;
      publishReason: string;
    }
  | { language: Language; success: false; error: string };

/**
 * Fetch the photo set shared by both languages. Returns `undefined` (not an error) when
 * Unsplash fails — each language then self-fetches, so a photo hiccup never blocks the
 * articles, at the cost of the "same image" guarantee for that one run.
 */
async function fetchSharedImages(query: string): Promise<UnsplashImage[] | undefined> {
  try {
    const images = await searchImages(query, SHARED_IMAGE_COUNT);
    if (images.length < SHARED_IMAGE_COUNT) {
      console.error(`[CRON/blog] shared image query "${query}" returned ${images.length}/${SHARED_IMAGE_COUNT}; langs will self-fetch`);
      return undefined;
    }
    // Trigger the download pings once here (Unsplash guideline) since the generator skips
    // its own search + ping when images are supplied.
    for (const img of images) {
      await triggerDownload(img.downloadLocation);
    }
    return images;
  } catch (err) {
    console.error(`[CRON/blog] shared image fetch failed for "${query}"; langs will self-fetch:`, err);
    return undefined;
  }
}

/**
 * Generate one language. Never throws — a failure comes back as a LangOutcome so the other
 * language is still attempted.
 */
async function generateOne(
  topic: string,
  lang: Language,
  keywords: string[],
  season: Season,
  images: UnsplashImage[] | undefined,
): Promise<LangOutcome> {
  const tag = lang.toUpperCase();
  try {
    const result = await generateBlogArticle({
      topic,
      lang,
      keywords,
      season,
      autoPublish: true,
      ...(images ? { images } : {}),
    });
    console.log(
      `[CRON/blog] ${tag} article created: ${result.articleId} (${result.title}) — ` +
        `score=${result.score ?? "n/a"} published=${result.published} (${result.publishReason})`,
    );
    return {
      language: lang,
      success: true,
      articleId: result.articleId,
      adminUrl: result.adminUrl,
      title: result.title,
      published: result.published,
      score: result.score,
      publishReason: result.publishReason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRON/blog] ${tag} generation failed:`, err);
    return { language: lang, success: false, error: msg };
  }
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const sel = selectBilingualTopic(new Date());

  console.log(`[CRON/blog] week=${sel.week} idx=${sel.idx} FR="${sel.fr}" EN="${sel.en}" img="${sel.imageQuery}"`);

  // trackCron records the run (success/error) in cron_runs for the dashboard. The work throws
  // on total failure so it is logged as 'error'; the outer catch turns that back into the
  // same 500 response shape.
  let articles: LangOutcome[] = [];
  let sharedCount = 0;
  try {
    const generated = await trackCron("blog", async () => {
      // One shared photo set for the whole pair → identical imagery FR + EN.
      const sharedImages = await fetchSharedImages(sel.imageQuery);
      sharedCount = sharedImages ? sharedImages.length : 0;
      console.log(`[CRON/blog] shared images: ${sharedImages ? sharedImages.length : "none (self-fetch)"}`);

      const fr = await generateOne(sel.fr, "fr", sel.keywordsFr, sel.season, sharedImages);

      console.log(`[CRON/blog] Waiting ${BETWEEN_LANGS_DELAY_MS}ms before EN`);
      await new Promise((r) => setTimeout(r, BETWEEN_LANGS_DELAY_MS));

      const en = await generateOne(sel.en, "en", sel.keywordsEn, sel.season, sharedImages);

      articles = [fr, en];
      const count = articles.filter((a) => a.success).length;
      const publishedCount = articles.filter((a) => a.success && a.published).length;
      console.log(`[CRON/blog] Complete — ${count}/2 articles created, ${publishedCount} auto-published`);
      if (count === 0) {
        // Propagate each language's real failure into the thrown message so trackCron records
        // it in cron_runs.detail. Without this the dashboard only ever showed the generic
        // wrapper text and the actual cause stayed buried in the Vercel function logs — which
        // is exactly how a 401 on the old self-fetch went unnoticed for weeks.
        const detail = articles
          .map((a) => `${a.language.toUpperCase()}: ${a.success ? "ok" : a.error}`)
          .join(" | ");
        throw new Error(`Both FR and EN blog generations failed — ${detail}`);
      }
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
