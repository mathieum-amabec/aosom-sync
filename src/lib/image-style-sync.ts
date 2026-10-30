/**
 * Fill the image_styles cache (lifestyle vs studio) for every active product photo, so the
 * Meta feeds can keep studio packshots out of ads (see image-style.ts and
 * feeds/source.ts#fetchImageStyles). Pixel heuristic only — no tokens, no Shopify writes.
 * Only stems not yet cached are downloaded, so after the first backfill a run costs a few
 * dozen image fetches (the day's new imports).
 */
import { fetchShopifyFeedProducts } from "./feeds/source";
import { imageUrlStem } from "./image-compliance-audit";
import { classifyAdImageStyle, type AdImageStyle } from "./image-style";
import { getCachedImageStyles, putCachedImageStyles } from "./database";

const CONCURRENCY = 16;
/** Stop starting new downloads after this long so the route returns well inside maxDuration. */
const TIME_BUDGET_MS = 240_000;

export interface ImageStyleSyncResult {
  photos: number;
  cached: number;
  missing: number;
  classified: number;
  lifestyle: number;
  studio: number;
  failed: number;
  /** Missing photos left for the next run (time budget or limit reached). */
  deferred: number;
}

export async function syncImageStyles(opts: { limit?: number } = {}): Promise<ImageStyleSyncResult> {
  const started = Date.now();
  const products = await fetchShopifyFeedProducts();
  const byStem = new Map<string, string>();
  for (const p of products) {
    if (p.status !== "active") continue;
    for (const img of p.images ?? []) {
      const stem = imageUrlStem(img.src);
      if (stem && !byStem.has(stem)) byStem.set(stem, img.src);
    }
  }
  const cached = await getCachedImageStyles([...byStem.keys()]);
  const missing = [...byStem.entries()].filter(([stem]) => !cached.has(stem));
  const queue = missing.slice(0, opts.limit ?? missing.length);
  const results: Array<{ stem: string; style: AdImageStyle; sampleUrl: string }> = [];
  let failed = 0;
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < queue.length && Date.now() - started < TIME_BUDGET_MS) {
      const [stem, url] = queue[next++];
      const style = await classifyAdImageStyle(url);
      if (style) results.push({ stem, style, sampleUrl: url });
      else failed++;
    }
  }));
  await putCachedImageStyles(results);
  const lifestyle = results.filter((r) => r.style === "lifestyle").length;
  return {
    photos: byStem.size,
    cached: cached.size,
    missing: missing.length,
    classified: results.length,
    lifestyle,
    studio: results.length - lifestyle,
    failed,
    deferred: missing.length - results.length - failed,
  };
}
