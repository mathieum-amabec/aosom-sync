/**
 * Types for the image-carousel engine (Module E).
 *
 * A carousel is a set of branded square/portrait PNGs (one per product) for a
 * Meta/Instagram feed carousel — the still-image counterpart to the video
 * slideshow. It shares the slideshow's hard rules: every `image_url` is a
 * cdn.shopify.com URL, titles are cleaned (no supplier brand), and a discount
 * badge shows ONLY when compare_at >= price * 1.10.
 */
import type { SlideshowItem, SlideshowBrand, SlideshowLanguage } from "../types";

/** Feed-carousel output sizes: 1:1 square or 4:5 portrait (Meta's tallest feed). */
export type CarouselFormat = "1080x1080" | "1080x1350";

/** A fully-specified carousel render request. */
export interface CarouselConfig {
  /** 1+ slides; each image_url MUST start with https://cdn.shopify.com/. */
  items: SlideshowItem[];
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  format: CarouselFormat;
  /** When true, renderCarousel returns a manifest and writes nothing. */
  dryRun?: boolean;
}

/** One line of a dry-run manifest — what WOULD be drawn on a card. */
export interface CarouselManifestItem {
  image_url: string;
  /** Overlay text AFTER formatVideoTitle cleanup (what the viewer would see). */
  overlay_text: string;
  price: number;
  compare_at?: number;
  /** Whether a discount badge would be shown (compare_at >= price * 1.10). */
  showsBadge: boolean;
  discountPct?: number;
  sku?: string;
}

/** Dry-run output: a full description of the PNGs a real render would produce. */
export interface CarouselManifest {
  items: CarouselManifestItem[];
  format: CarouselFormat;
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  count: number;
  /** The Blob path PREFIX a real render would upload the numbered PNGs under. */
  wouldUploadTo: string;
  dryRun: true;
}

/** Result of renderCarousel. Exactly one of `blobUrls` / `manifest` is set. */
export interface CarouselResult {
  /** Set on a real render: the public Blob URLs of each PNG, in slide order. */
  blobUrls?: string[];
  /** Set on a dry run: the manifest of what would have been produced. */
  manifest?: CarouselManifest;
}
