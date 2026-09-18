/**
 * Approval-queue wiring for the remix engine (Module F).
 *
 * `renderRemix` (render.ts) only produces a blob URL — it never touches
 * `publication_queue`. This module is the missing last mile: it turns a
 * `RemixResult` into a `content_type='video'` `status='draft'` row, the exact
 * same shape `/videos` already lists and approves (see
 * `src/app/api/slideshow/queue/route.ts` + `.../approve/route.ts`). A remix
 * therefore needs ZERO new UI — it shows up in the existing video approval
 * queue automatically. Nothing here ever inserts with `status: 'pending'` or
 * calls the publisher: approval is a separate, human-triggered step.
 */
import { introTitle } from "./render";
import type { RemixResult, RemixTheme } from "./types";
import type { SlideshowLanguage } from "../types";

export const REMIX_THEMES: RemixTheme[] = ["ete-cour", "maison", "enfants", "bureau", "animaux", "soldes"];

export interface RemixQueueDraft {
  contentId: string;
  platform: "both";
  payload: string;
  metadata: { source: "remix"; theme: string };
}

/**
 * Build the draft's `contentId` + JSON payload from a real (non-dry-run) RemixResult.
 * Pure — no I/O, no DB, unit-testable without ffmpeg or a live Turso connection.
 * Throws if `result` is a dry-run manifest (no blobUrl) — callers must never queue a
 * dry run as a real draft.
 */
export function buildRemixQueueDraft(
  theme: string,
  result: RemixResult,
  language: SlideshowLanguage,
  timestamp: number = Date.now(),
): RemixQueueDraft {
  if (!result.blobUrl) {
    throw new Error("buildRemixQueueDraft: RemixResult has no blobUrl (dry run?) — refusing to queue");
  }
  const caption = introTitle(theme, result.clipCount, language);
  return {
    contentId: `remix:${theme}:${timestamp}`,
    platform: "both",
    payload: JSON.stringify({ caption, brand: "ameublo", reelsVideoUrl: result.blobUrl }),
    metadata: { source: "remix", theme },
  };
}
