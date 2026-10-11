/**
 * Daily gallery classification — keeps every photo of every live product judged.
 *
 * The ad feeds (feeds/source.ts) only serve a secondary image (the Meta carousel) once it has a
 * positive "compliant" verdict in image_classifications. The daily pos-1 guard
 * (image-compliance.ts) only judges position 1, so without this pass a NEW product's secondary
 * photos would stay unclassified forever and never reach a carousel. This pass classifies the
 * never-judged photos of every active, published product (Gemini, same strict "no text, no
 * dimensions, no marketing overlay" prompt as scripts/classify-gallery-images.mts) so they are
 * either cleared for the carousel or flagged and dropped.
 *
 * Bounded by a call cap AND a wall-clock budget so it can never threaten the 800 s sync
 * function. Best-effort: callers swallow failures. A missing GEMINI_API_KEY is a no-op.
 */
import { env, SHOPIFY } from "./config";
import { imageUrlStem } from "./image-compliance-audit";
import { classifyProductImageGemini } from "./vision-classifier";
import { getCachedImageVerdicts, putCachedImageVerdict } from "./database";

const MODEL_LABEL = "gemini-3.5-flash-lite"; // same label scripts/classify-gallery-images.mts stores
const DEFAULT_MAX_CALLS = 600;
const DEFAULT_BUDGET_MS = 150_000;
const REQUESTS_PER_SECOND = 4;

export interface GalleryPhoto { stem: string; url: string }

/** Distinct photos (by hash stem) with no cached verdict, first-seen order, capped at `limit`. */
export function selectUncachedPhotos(
  photos: GalleryPhoto[],
  cachedStems: ReadonlySet<string>,
  limit: number,
): GalleryPhoto[] {
  const seen = new Set<string>();
  const out: GalleryPhoto[] = [];
  for (const p of photos) {
    if (!p.stem || seen.has(p.stem)) continue;
    seen.add(p.stem);
    if (cachedStems.has(p.stem)) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

function nextPageInfo(link: string | null): string | null {
  const part = link?.split(",").find((s) => s.includes('rel="next"'));
  const m = part && /<([^>]+)>/.exec(part);
  return m ? new URL(m[1]).searchParams.get("page_info") : null;
}

async function fetchLivePhotos(): Promise<GalleryPhoto[]> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not configured");
  const base = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}`;
  const out: GalleryPhoto[] = [];
  let pageInfo: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,status,published_at,images" });
    if (pageInfo) params.set("page_info", pageInfo);
    let res = await fetch(`${base}/products.json?${params}`, { headers: { "X-Shopify-Access-Token": token } });
    for (let t = 0; res.status === 429 && t < 4; t++) {
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
      res = await fetch(`${base}/products.json?${params}`, { headers: { "X-Shopify-Access-Token": token } });
    }
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = (await res.json()) as { products: { status: string; published_at: string | null; images?: { src: string }[] }[] };
    for (const p of data.products) {
      if (p.status !== "active" || !p.published_at) continue;
      for (const img of p.images ?? []) out.push({ stem: imageUrlStem(img.src), url: img.src });
    }
    pageInfo = nextPageInfo(res.headers.get("Link"));
    pages++;
  } while (pageInfo && pages < 40);
  return out;
}

export interface GalleryClassificationResult {
  skipped?: string;
  uncachedBefore: number;
  classified: number;
  flagged: number;
  errors: number;
}

export async function runGalleryClassification(
  opts: { maxCalls?: number; budgetMs?: number } = {},
): Promise<GalleryClassificationResult> {
  if (!env.hasGeminiKey) return { skipped: "no GEMINI_API_KEY", uncachedBefore: 0, classified: 0, flagged: 0, errors: 0 };
  const t0 = Date.now();
  const photos = await fetchLivePhotos();
  const stems = [...new Set(photos.map((p) => p.stem).filter(Boolean))];
  const cached = await getCachedImageVerdicts(stems);
  const all = selectUncachedPhotos(photos, new Set(cached.keys()), Infinity);
  const todo = all.slice(0, opts.maxCalls ?? DEFAULT_MAX_CALLS);
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  let classified = 0, flagged = 0, errors = 0;
  for (let i = 0; i < todo.length && Date.now() - t0 < budget; i += REQUESTS_PER_SECOND) {
    const started = Date.now();
    await Promise.all(todo.slice(i, i + REQUESTS_PER_SECOND).map(async (p) => {
      try {
        const verdict = await classifyProductImageGemini(p.url);
        await putCachedImageVerdict(p.stem, verdict, { model: MODEL_LABEL, sampleUrl: p.url });
        classified++;
        if (!verdict.compliant) flagged++;
      } catch (err) {
        errors++;
        if (errors <= 3) console.warn(`[GALLERY-CLASSIFY] ${p.stem}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
    const wait = 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return { uncachedBefore: all.length, classified, flagged, errors };
}
