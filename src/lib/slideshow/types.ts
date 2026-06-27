/**
 * Shared types for the slideshow / montage content engine (Module A).
 *
 * This is the contract every downstream module (C/D/E/F/G) builds against, so
 * it is deliberately small, explicit, and host-constrained.
 *
 * ── Hard constraints encoded here ─────────────────────────────────────────
 *  - Every `image_url` MUST be a `https://cdn.shopify.com/` URL. Aosom CDN
 *    (`img-us.aosomcdn.com`) returns 403 to our render workers, so the catalog
 *    images (products.image1..7) are never used directly — content selectors
 *    resolve the Shopify-rehosted images instead (see src/lib/selectors).
 *  - No supplier brand names (Outsunny / HOMCOM / Aosom) ever reach an overlay;
 *    titles are cleaned via formatVideoTitle() before they are drawn.
 *  - A price/discount badge is shown ONLY when compare_at >= price * 1.10.
 */

/** The two store brands. Drives language, logo, and store URL on the cards. */
export type SlideshowBrand = "ameublo" | "furnish";

/** Output aspect ratio. 9:16 (Reels/Shorts), 1:1 (feed), 16:9 (YouTube). */
export type SlideshowRatio = "9:16" | "1:1" | "16:9";

/** UI / overlay language. `ameublo` is FR, `furnish` is EN, but callers may override. */
export type SlideshowLanguage = "fr" | "en";

/**
 * Content / pacing template. The renderer maps each to intro copy, slide pacing
 * and badge emphasis; selectors (Module B) decide which products fill it.
 */
export enum SlideshowTemplate {
  /** Single hero product, multiple angles. */
  SHOWCASE = "SHOWCASE",
  /** Top movers by 14-day velocity. */
  BEST_SELLERS = "BEST_SELLERS",
  /** Active rabais (compare_at >= price * 1.10). */
  PRICE_DROP = "PRICE_DROP",
  /** Low-stock scarcity push. */
  URGENCY = "URGENCY",
  /** Curated by-category style edit. */
  LOOKBOOK = "LOOKBOOK",
  /** Surprising / high-margin discovery. */
  DISCOVERY = "DISCOVERY",
  /** Seasonal countdown / event. */
  COUNTDOWN = "COUNTDOWN",
  /** Remix of a previously rendered set. */
  REMIX = "REMIX",
}

/** One slide: a single product photo with its overlay metadata. */
export interface SlideshowItem {
  /** MUST start with `https://cdn.shopify.com/`. Validated before render. */
  image_url: string;
  /** Raw overlay text (cleaned by formatVideoTitle before drawing). */
  overlay_text: string;
  /** Current sell price (CAD). */
  price: number;
  /**
   * The "compare at" / pre-discount price, when one exists. Derived from the
   * latest price_history drop (this schema has no compare_at_price column).
   * A discount badge renders ONLY when this is >= price * 1.10.
   */
  compare_at?: number;
  /** Optional product SKU (for traceability / REMIX). */
  sku?: string;
  /**
   * Lifestyle opener: a non-product hero slide whose `image_url` may be an
   * Unsplash photo (an allow-listed host) and whose `overlay_text` is a big
   * centered hook (no price/badge). Product slides stay cdn.shopify.com-only.
   */
  hero?: boolean;
}

/** A fully-specified render request. */
export interface SlideshowConfig {
  items: SlideshowItem[];
  template: SlideshowTemplate;
  ratio: SlideshowRatio;
  /** Optional royalty-free music URL/path; falls back to getDefaultMusicTrack(). */
  musicUrl?: string;
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  /** Slideshow title shown on the intro card. */
  title?: string;
  /**
   * Target total runtime in seconds (e.g. 6/15/30). The renderer solves the
   * per-slide hold to land near this, clamped to a watchable range. Omit for the
   * default fixed pacing.
   */
  targetDurationSec?: number;
  /** When true, renderSlideshow returns a manifest and writes nothing. */
  dryRun?: boolean;
}

/** One line of a dry-run manifest — what WOULD be drawn for a slide. */
export interface ManifestItem {
  image_url: string;
  /** The overlay text AFTER formatVideoTitle cleanup (what the viewer would see). */
  overlay_text: string;
  price: number;
  compare_at?: number;
  /** Whether a discount badge would be shown (compare_at >= price * 1.10). */
  showsBadge: boolean;
  discountPct?: number;
  sku?: string;
}

/**
 * Dry-run output: a complete description of what a real render would produce,
 * without downloading images, invoking ffmpeg, or touching Vercel Blob.
 */
export interface SlideshowManifest {
  items: ManifestItem[];
  template: string;
  ratio: string;
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  title?: string;
  /** Whether a music track would be mixed in, and which. */
  music: string | null;
  estimatedDurationSec: number;
  /** The Blob path a real render would upload to. */
  wouldUploadTo: string;
  dryRun: true;
}

/** Result of renderSlideshow. Exactly one of `blobUrl` / `manifest` is set. */
export interface SlideshowResult {
  /** Set on a real render: the public Vercel Blob URL of the MP4. */
  blobUrl?: string;
  /** Set on a dry run: the manifest of what would have been produced. */
  manifest?: SlideshowManifest;
  /** Estimated (dry run) or actual (real) total runtime in seconds. */
  durationSec: number;
}

/** Result of validateSlideshowConfig. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
