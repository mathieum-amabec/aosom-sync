/**
 * Costway photo order — the store rule (since July 2026, Mat reminded 2026-10-17): position 1 is a CLEAN LIFESTYLE photo
 * (the product in a room, garden, in use; people allowed; no marketing text), and only when none exists the clean studio
 * shot. Same check as the Aosom auto-import (auto-import/verify.ts#analyzeAndCleanGallery: one vision call over the
 * first six photos, a second over the next six when none of them can lead), so both suppliers follow one rule.
 */
import { analyzeAndCleanGallery } from "@/lib/auto-import/verify";

export type LifestyleOutcome =
  /** A clean lifestyle photo leads. */
  | "lifestyle"
  /** No clean lifestyle photo exists: the clean studio shot leads (allowed fallback). */
  | "studio"
  /** Every candidate carries text/logos, or the photos could not be checked: needs a human. */
  | "no_alternative";

export interface LifestyleResult {
  images: string[];
  outcome: LifestyleOutcome;
  /** Photos left out (supplier logo added over the photo, watermark, not the product, unreachable). */
  dropped: string[];
  reasons: string[];
}

export async function lifestyleFirst(
  urls: string[],
  analyze: typeof analyzeAndCleanGallery = analyzeAndCleanGallery,
): Promise<LifestyleResult> {
  const { analysis, cleaned } = await analyze(urls);
  if (!analysis.ok || !cleaned) return { images: urls, outcome: "no_alternative", dropped: [], reasons: analysis.reasons };
  if (cleaned.reasons.length) return { images: cleaned.images, outcome: "no_alternative", dropped: cleaned.dropped, reasons: cleaned.reasons };
  return { images: cleaned.images, outcome: cleaned.hasLifestyle ? "lifestyle" : "studio", dropped: cleaned.dropped, reasons: [] };
}
