/**
 * LOOKBOOK — a lifestyle / ambiance edit.
 *
 * Pulls a curated set (by category when given, else current best-sellers) and
 * renders a styled product montage.
 *
 * B-roll caveat: the brief calls for interleaving ambiance B-roll (Pexels /
 * Unsplash) between product slides. The core engine (Module A) enforces a hard
 * invariant — every rendered image MUST be a https://cdn.shopify.com/ URL — and
 * every template must delegate to renderSlideshow(). External B-roll frames are
 * neither Shopify-CDN nor re-hosted, so they cannot be rendered as slides
 * without weakening that invariant or forking the shared engine. We therefore
 * fetch B-roll only to detect availability (keeping the integration ready and
 * logging what we found), and render PRODUCT-ONLY regardless. When no provider
 * is configured we log a warning and fall back the same way — never throwing.
 */
import { bestSellers, byCategory } from "@/lib/selectors";
import { SlideshowTemplate, type SlideshowResult } from "@/lib/slideshow/types";
import {
  type BaseTemplateOptions,
  DEFAULT_ITEM_LIMIT,
  ensureItems,
  localized,
  productsToSlideItems,
  renderTemplate,
  resolveLanguage,
} from "./shared";

export interface BuildLookbookOptions extends BaseTemplateOptions {
  /** product_type to curate (omit to feature current best-sellers). */
  category?: string;
  /** Number of products to feature (default 8). */
  limit?: number;
}

interface BrollResult {
  source: "pexels" | "unsplash" | "none";
  images: string[];
}

/**
 * Fetch ambiance B-roll image URLs. Prefers Pexels (PEXELS_API_KEY), then
 * Unsplash (UNSPLASH_ACCESS_KEY). Never throws and never blocks the render —
 * returns { source: "none", images: [] } when nothing is configured or a
 * provider errors.
 */
async function fetchBroll(query: string, count: number): Promise<BrollResult> {
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    try {
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
      const res = await fetch(url, { headers: { Authorization: pexelsKey } });
      if (res.ok) {
        const data = (await res.json()) as {
          photos?: { src?: { large?: string; portrait?: string; original?: string } }[];
        };
        const images = (data.photos ?? [])
          .map((p) => p.src?.portrait || p.src?.large || p.src?.original || "")
          .filter(Boolean);
        if (images.length > 0) return { source: "pexels", images };
      }
    } catch {
      /* fall through to Unsplash */
    }
  }

  if (process.env.UNSPLASH_ACCESS_KEY) {
    try {
      const { searchImages } = await import("@/lib/unsplash");
      const results = await searchImages(query, count);
      const images = results.map((r) => r.url).filter(Boolean);
      if (images.length > 0) return { source: "unsplash", images };
    } catch {
      /* fall through to none */
    }
  }

  return { source: "none", images: [] };
}

export async function buildLookbook(opts: BuildLookbookOptions): Promise<SlideshowResult> {
  const language = resolveLanguage(opts);
  const limit = opts.limit ?? DEFAULT_ITEM_LIMIT;

  const products = opts.category
    ? await byCategory({ category: opts.category, sort: "velocity", limit, language })
    : await bestSellers({ limit, language });
  const items = productsToSlideItems(products, language, limit);
  ensureItems(items, SlideshowTemplate.LOOKBOOK);

  // Best-effort ambiance B-roll (see file header for why it isn't rendered).
  const query = opts.category || localized(language, "intérieur maison moderne", "modern home interior");
  const broll = await fetchBroll(query, Math.max(2, Math.ceil(items.length / 2)));
  if (broll.source === "none") {
    console.warn(
      "[lookbook] no B-roll provider configured (PEXELS_API_KEY / UNSPLASH_ACCESS_KEY) — rendering product-only lookbook",
    );
  } else {
    console.warn(
      `[lookbook] fetched ${broll.images.length} ${broll.source} B-roll frame(s), but renderSlideshow enforces cdn.shopify.com-only imagery — rendering product-only lookbook`,
    );
  }

  return renderTemplate({
    items,
    template: SlideshowTemplate.LOOKBOOK,
    title: localized(language, "Inspirez votre espace", "Inspire your space"),
    language,
    opts,
  });
}
