/**
 * Types for the remix engine (Module F).
 *
 * Module F is fundamentally different from the Module A slideshow renderer:
 * instead of rendering product *images* into a montage, it compiles the 210
 * already-rendered demand-gen *videos* (the `video_demand_gen` table, one row
 * per sku/ratio/duration with a PUBLIC `blob_url`) into new thematic
 * compilations. No re-render from source — the marginal cost is ~one ffmpeg
 * concat + one Blob upload, the clips themselves are reused as-is.
 *
 * The contract is intentionally small and mirrors the Module A types shape
 * (a dryRun manifest path that touches no ffmpeg / network, and a real path
 * that returns a PUBLIC Blob URL).
 */
import type { SlideshowBrand, SlideshowRatio, SlideshowLanguage } from "../types";

/** The curated themes a remix can be built around (maps to product_type sets). */
export type RemixTheme =
  | "ete-cour"
  | "maison"
  | "enfants"
  | "bureau"
  | "animaux"
  | "soldes";

/** Optional filter to a single source-clip duration bucket. */
export type RemixDurationFilter = "6s" | "15s" | "30s";

/** A fully-specified remix request. */
export interface RemixConfig {
  /** Theme slug (see THEME_PRODUCT_TYPES). Kept as `string` so callers may pass
   * an ad-hoc theme; unknown themes fall back to "no product_type filter". */
  theme: string;
  /** Explicit product_type refinement; overrides the theme map when set. */
  category?: string;
  ratio: SlideshowRatio;
  /** Restrict to clips of one rendered duration (6/15/30s). */
  duration_filter?: RemixDurationFilter;
  /** Max number of clips in the compilation (default DEFAULT_MAX_CLIPS). */
  max_clips?: number;
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  /** When true, renderRemix returns a manifest and writes nothing. */
  dryRun?: boolean;
}

/** One source clip selected for the compilation. */
export interface RemixClip {
  sku: string;
  title_fr: string;
  blob_url: string;
  duration_sec: number;
  ratio: string;
}

/**
 * Dry-run output: the full description of what a real remix would produce,
 * without downloading any clip, invoking ffmpeg, or touching Vercel Blob.
 */
export interface RemixManifest {
  theme: string;
  clips: RemixClip[];
  estimatedDurationSec: number;
  /** The PUBLIC Blob path a real render would upload to. */
  wouldUploadTo: string;
  dryRun: true;
}

/** Result of renderRemix. Exactly one of `blobUrl` / `manifest` is set. */
export interface RemixResult {
  /** Set on a real render: the public Vercel Blob URL of the MP4. */
  blobUrl?: string;
  /** Set on a dry run: the manifest of what would have been produced. */
  manifest?: RemixManifest;
  /** Number of source clips that went into (or would go into) the compilation. */
  clipCount: number;
}
