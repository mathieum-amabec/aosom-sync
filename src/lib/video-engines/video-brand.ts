/**
 * Engine-local brand tokens for the Kling + Creatomate video engines.
 *
 * Values mirror the foundation pipeline's brand tokens
 * (src/lib/video-brand-tokens.ts) — same navy/gold, same 1080×1920 frame, same
 * 200px bottom band — so a clip branded here is visually identical to the
 * FFmpeg slideshow engine. This file is the integration seam: once the two
 * branches land, these collapse into one shared module. Kept dependency-light
 * (only config) so it imports cleanly into both the Node (ffmpeg) and fetch-only
 * (Creatomate) code paths.
 */
import { getPublicAppUrl } from "../config";

export type VideoLocale = "fr" | "en";

export const VIDEO_BRAND = {
  /** Deep navy used for the lower band behind the logo/CTA. */
  navy: "#1A2340",
  /** Gold accent for highlights/CTA text. */
  gold: "#D4A853",
  /** Off-white text drawn on the navy band. */
  textColor: "#FAFAF8",
  /** Bottom branded band height in px (frame is 1080×1920). */
  bandHeight: 200,
  /** Sans family for any drawtext overlay (ffmpeg resolves a system fallback). */
  fontFamily: "DM Sans",
  /** Vertical 9:16 output the engines target (Reels / Shorts). */
  reel: { width: 1080, height: 1920 } as const,
  /** Store URL shown on the band. */
  storeUrl: "ameublodirect.ca",
} as const;

/** Per-brand display name shown on the band. fr → Ameublo, en → Furnish Direct. */
export function brandLabel(locale: VideoLocale): string {
  return locale === "en" ? "Furnish Direct" : "Ameublo Direct";
}

/** Repo-relative logo asset path (under public/), mirroring the foundation tokens. */
export function brandLogoAsset(locale: VideoLocale): string {
  return `Logo/logo-${locale}.png`;
}

/**
 * Public, https logo URL for the locale's brand, or null when the app's public
 * base URL can't be resolved (local dev without NEXT_PUBLIC_APP_URL). Callers
 * that need a hosted logo (Creatomate `logo_url`) skip branding rather than emit
 * an unreachable URL — same contract as getPublicAppUrl().
 */
export function brandLogoUrl(locale: VideoLocale): string | null {
  const base = getPublicAppUrl();
  if (!base) return null;
  return `${base}/${brandLogoAsset(locale)}`;
}
