/**
 * Orchestration: render one remix theme and queue it as an approval-pending
 * video draft. Shared by `POST /api/remix/generate` (operator-triggered, any
 * theme) and `GET /api/cron/remix` (weekly rotation). Never schedules or
 * publishes — see queue.ts for why `status: 'draft'` is non-negotiable here.
 */
import { addToQueue, getOccupiedQueueSlots, getSetting, QueueSlotTakenError } from "@/lib/database";
import { getNextAvailableSlot, parseVideoSchedule } from "@/lib/publication-scheduler";
import { renderRemix } from "./render";
import { buildRemixQueueDraft } from "./queue";
import type { SlideshowRatio, SlideshowLanguage, SlideshowBrand } from "../types";

export interface GenerateRemixResult {
  queueId: number;
  theme: string;
  clipCount: number;
  blobUrl: string;
}

export async function generateAndQueueRemix(opts: {
  theme: string;
  ratio?: SlideshowRatio;
  language?: SlideshowLanguage;
  maxClips?: number;
  durationFilter?: "6s" | "15s" | "30s";
}): Promise<GenerateRemixResult> {
  const ratio = opts.ratio ?? "9:16";
  const language = opts.language ?? "fr";
  const brand: SlideshowBrand = language === "en" ? "furnish" : "ameublo";

  const result = await renderRemix({
    theme: opts.theme,
    ratio,
    language,
    brand,
    max_clips: opts.maxClips,
    duration_filter: opts.durationFilter,
    dryRun: false,
  });
  if (!result.blobUrl) {
    throw new Error("renderRemix produced no blobUrl (unexpected for a non-dry-run call)");
  }

  const draft = buildRemixQueueDraft(opts.theme, result, language);

  // Draft rows aren't slot-reserving, but scheduled_at is a NOT NULL formatted column —
  // pick a tentative next-free video slot (mirrors scripts/render-sequential-ads.mts);
  // the real slot is recomputed when a human approves in /videos.
  const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots("both", "video")).map(
    (s) => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000),
  );
  const next = await getNextAvailableSlot("facebook", {}, { nowSec, occupied, schedule: videoSchedule, contentType: "video" });
  if (!next) {
    throw new Error("No free video slot to place the tentative draft in (schedule disabled or full)");
  }

  try {
    const queueId = await addToQueue({
      contentType: "video",
      contentId: draft.contentId,
      platform: draft.platform,
      payload: draft.payload,
      scheduledAt: next.sqlite,
      status: "draft",
      metadata: draft.metadata,
    });
    return { queueId, theme: opts.theme, clipCount: result.clipCount, blobUrl: result.blobUrl };
  } catch (err) {
    if (err instanceof QueueSlotTakenError) {
      throw new Error("Slot collision placing the draft — retry");
    }
    throw err;
  }
}
