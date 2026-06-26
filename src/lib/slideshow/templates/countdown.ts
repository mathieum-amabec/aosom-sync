/**
 * Countdown template (Module D) — "Top 5 du mois" as a 9:16 Remotion Reel.
 *
 * buildCountdown picks the 5 best sellers (by stock-depletion velocity), keeps
 * only those with a Shopify-CDN photo, and either:
 *   - dryRun:true  → returns a MANIFEST (what would render) with NO Remotion
 *     bundle/render and NO Blob write; or
 *   - dryRun:false → bundles src/remotion, renders the TopFiveCountdown MP4 with
 *     @remotion/renderer, and uploads it to the PUBLIC Vercel Blob store.
 *
 * Remotion is dynamically imported ONLY on the real-render path, so the dry run
 * (and its tests) never load the Remotion runtime or a headless browser. The
 * timing/duration come from the shared, Remotion-free `@/remotion/timing` model
 * so the manifest and the rendered video always agree.
 *
 * ── Remotion licence ──────────────────────────────────────────────────────
 * Remotion is FREE for individuals and companies with ≤ 3 employees (our case).
 * Larger teams need a paid company licence (~$100/mo). See CHANGELOG / README.
 */
import path from "path";
import fs from "fs";
import { bestSellers } from "@/lib/selectors";
import type { ProductItem } from "@/lib/selectors/types";
import { isShopifyCdnUrl, shouldShowBadge, discountPct } from "@/lib/slideshow/validate";
import { blobPath } from "@/lib/slideshow/render";
import { formatVideoTitle } from "@/lib/video-title-utils";
import { countdownDurationSec } from "@/remotion/timing";
import type {
  SlideshowBrand,
  SlideshowLanguage,
  SlideshowResult,
  SlideshowManifest,
  ManifestItem,
} from "@/lib/slideshow/types";
import type { TopFiveCountdownProps } from "@/remotion/compositions/TopFiveCountdown";

/** Exactly how many products a Top-5 countdown needs. */
export const COUNTDOWN_ITEM_COUNT = 5;

export interface BuildCountdownOptions {
  /** Velocity window for the best-sellers ranking (days). Default 30. */
  windowDays?: number;
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  /** When true, return a manifest and render/upload nothing. */
  dryRun?: boolean;
}

/** Clean overlay title — matches the composition's `titleOf`. */
function titleOf(item: ProductItem, language: SlideshowLanguage): string {
  const raw = language === "en" ? item.title_en : item.title_fr;
  return formatVideoTitle(raw, 34, { uppercase: false, aggressive: false });
}

/** Map a best-seller ProductItem to a manifest line (post-cleanup, badge rule applied). */
function toManifestItem(item: ProductItem, language: SlideshowLanguage): ManifestItem {
  const compareAt = item.compare_at_price;
  return {
    image_url: item.images[0] ?? "",
    overlay_text: titleOf(item, language),
    price: item.price,
    compare_at: compareAt,
    showsBadge: shouldShowBadge(item.price, compareAt),
    discountPct: discountPct(item.price, compareAt),
    sku: item.sku,
  };
}

/** Build the dry-run manifest for a countdown. Pure — no Remotion, no I/O. */
export function buildCountdownManifest(
  items: ProductItem[],
  opts: BuildCountdownOptions,
  timestamp: number,
): SlideshowManifest {
  return {
    items: items.map((it) => toManifestItem(it, opts.language)),
    template: "COUNTDOWN",
    ratio: "9:16",
    brand: opts.brand,
    language: opts.language,
    title: "TOP 5",
    // The countdown render carries no music track (Remotion stage is silent).
    music: null,
    estimatedDurationSec: countdownDurationSec(items.length),
    wouldUploadTo: blobPath(opts.brand, "COUNTDOWN", "9:16", timestamp),
    dryRun: true,
  };
}

/**
 * Select the 5 best-sellers that have a usable Shopify-CDN photo, preserving the
 * velocity ranking (index 0 = #1). Throws if fewer than 5 qualify — a Top-5
 * countdown is all-or-nothing.
 */
async function selectCountdownItems(opts: BuildCountdownOptions): Promise<ProductItem[]> {
  const ranked = await bestSellers({ limit: COUNTDOWN_ITEM_COUNT * 3, windowDays: opts.windowDays ?? 30 });
  const usable = ranked.filter((p) => isShopifyCdnUrl(p.images[0])).slice(0, COUNTDOWN_ITEM_COUNT);
  if (usable.length < COUNTDOWN_ITEM_COUNT) {
    throw new Error(
      `buildCountdown: need ${COUNTDOWN_ITEM_COUNT} best-sellers with Shopify-CDN images, got ${usable.length}`,
    );
  }
  return usable;
}

/**
 * Build a "Top 5" countdown Reel.
 *
 * dryRun → { manifest }. Real → renders the MP4 and returns { blobUrl }.
 */
export async function buildCountdown(opts: BuildCountdownOptions): Promise<SlideshowResult> {
  const items = await selectCountdownItems(opts);
  const timestamp = Date.now();

  if (opts.dryRun) {
    const manifest = buildCountdownManifest(items, opts, timestamp);
    return { manifest, durationSec: manifest.estimatedDurationSec };
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("buildCountdown: BLOB_READ_WRITE_TOKEN is required for a real render (public store)");
  }

  // Heavy Remotion runtime loaded ONLY for a real render.
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition, renderMedia } = await import("@remotion/renderer");

  const inputProps: TopFiveCountdownProps = { items, brand: opts.brand, language: opts.language };
  const entryPoint = path.resolve(process.cwd(), "src/remotion/index.ts");
  // mkdtempSync needs its parent to exist (/tmp on Vercel; create the local .work base otherwise).
  const workBase = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), "public", "social-videos", ".work");
  fs.mkdirSync(workBase, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(workBase, "countdown-"));
  const outPath = path.join(workDir, "countdown.mp4");

  try {
    const serveUrl = await bundle({ entryPoint });
    const composition = await selectComposition({ serveUrl, id: "TopFiveCountdown", inputProps });
    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outPath, inputProps });

    const { put } = await import("@vercel/blob");
    const buffer = await fs.promises.readFile(outPath);
    const blob = await put(blobPath(opts.brand, "COUNTDOWN", "9:16", timestamp), buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { blobUrl: blob.url, durationSec: countdownDurationSec(items.length) };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* leave temp files rather than fail the render */
    }
  }
}
