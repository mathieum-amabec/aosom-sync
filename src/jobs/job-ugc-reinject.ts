/**
 * Job — UGC video reinjection into the social draft pipeline.
 *
 * Up to 76 products carry a clean CA/US customer unboxing video
 * (`getUgcVideoCandidates`), but only 15 ever show at once on the homepage reel
 * (`getUgcVideoReel`), and `facebook_drafts.video_url` is NULL on 100% of existing
 * social drafts — no UGC video has ever been reused as organic social content, even
 * though the column to carry one has existed since day one.
 *
 * This job closes that gap WITHOUT touching approval/publishing: every draft it
 * creates lands in `facebook_drafts` at its default status ('draft'), same as every
 * other trigger in job4-social.ts. A human still approves via the existing /social or
 * /drafts UI before anything reaches `publication_queue`. See generateBilingual /
 * createFacebookDraft in job4-social.ts, reused here unchanged.
 *
 * Kept as a manual-trigger route (POST /api/social/ugc-reinject), not folded into the
 * existing daily cron (SOCIAL_DAILY_BATCH in job4-social.ts): that budget is already
 * tuned for the new_product/price_drop/stock_highlight mix, and this is a distinct,
 * finite backlog (dozens of videos, not a daily trickle) an operator should run in
 * deliberate batches rather than have silently grow the daily automated queue.
 */
import { getAllSettings, getUgcVideoCandidates, getProduct, createFacebookDraft, markProductPosted, isDraftVideoUrlUsed, type UgcVideoCandidate } from "@/lib/database";
import { env } from "@/lib/config";
import { generateBilingual } from "./job4-social";

export const DEFAULT_UGC_REINJECT_BATCH = 6;
// Pull more candidates than we need so already-used ones don't shrink the batch.
const CANDIDATE_POOL_SIZE = 40;

export interface UgcReinjectResult {
  draftId: number;
  sku: string;
  videoUgc: string;
}

/**
 * Generate up to `count` new social drafts from UGC videos never used in social
 * content before. Each draft is bilingual (FR/EN), scoped by product_type through
 * the same hook/hashtag system as every other post (mapProductTypeToScope), and
 * created in status 'draft' — never auto-approved, never auto-published.
 */
export async function generateUgcReinjectionBatch(count = DEFAULT_UGC_REINJECT_BATCH): Promise<UgcReinjectResult[]> {
  const settings = await getAllSettings();
  const pool: UgcVideoCandidate[] = await getUgcVideoCandidates(CANDIDATE_POOL_SIZE);

  const results: UgcReinjectResult[] = [];
  for (const candidate of pool) {
    if (results.length >= count) break;
    if (await isDraftVideoUrlUsed(candidate.videoUgc)) continue;

    const product = await getProduct(candidate.sku);
    const productType = product?.product_type ?? null;
    const { fr, en, hookId } = await generateBilingual(
      settings,
      "highlight",
      {
        product_name: candidate.name || candidate.sku,
        price: String(candidate.price ?? ""),
        qty: String(candidate.qty),
        store_name: env.storeName,
      },
      productType,
    );

    const draftId = await createFacebookDraft({
      sku: candidate.sku,
      triggerType: "ugc_reinject",
      language: "FR",
      postText: fr,
      postTextEn: en,
      videoUrl: candidate.videoUgc,
      reelsVideoUrl: candidate.videoUgc,
      hookId,
    });

    await markProductPosted(candidate.sku);
    results.push({ draftId, sku: candidate.sku, videoUgc: candidate.videoUgc });
  }

  return results;
}
