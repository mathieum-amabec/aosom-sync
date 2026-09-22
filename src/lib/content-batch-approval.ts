/**
 * Shared slot-safe "approve one content-batch draft" logic for the 3 content-scale-chantier
 * video formats (demand_gen_ext / before_after / assembly), factored out of
 * /api/content-batches/approve for testability — mirrors sequential-ad-approval.ts's
 * approveOneSequentialAd, generalized over `ContentBatchFormat` instead of one fixed type
 * and using each format's OWN recurring grid (parseContentBatchSchedule) instead of a single
 * shared video_schedule.
 *
 * Unlike sequential_ad, a content-batch draft's `scheduled_at` at generation time is a bogus
 * placeholder (the batch scripts set a random hour on a far-future date — there was no real
 * schedule to draw from yet), so there is no meaningful "try the draft's own tentative slot
 * first" step here: every approval computes a fresh slot from the format's grid.
 */
import {
  getQueueItemById,
  approveContentBatchDraft,
  getOccupiedQueueSlots,
  getSetting,
  QueueSlotTakenError,
} from "@/lib/database";
import {
  getNextAvailableSlot,
  parseContentBatchSchedule,
  CONTENT_BATCH_SCHEDULE_SETTING_KEY,
  type ContentBatchFormat,
  type PublishPlatform,
} from "@/lib/publication-scheduler";

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

export type ApproveContentBatchResult =
  | { success: true; queueId: number; scheduledAt: number; sqlite: string }
  | { success: false; queueId: number; error: string; status: number };

/**
 * Approve a single content-batch draft (draft → pending), auto-assigning it to the next free
 * slot on its format's own recurring grid. Retries on collision (up to 6 attempts, same
 * pattern as approveOneSequentialAd) — a real race is rare since each format's grid uses
 * times distinct from every other schedule, but the (platform, scheduled_at) uniqueness
 * constraint is global across every content_type, not scoped, so a collision is still
 * possible and must be handled rather than assumed away.
 */
export async function approveOneContentBatchDraft(
  queueId: number,
  contentType: ContentBatchFormat,
): Promise<ApproveContentBatchResult> {
  const row = await getQueueItemById(queueId);
  if (!row || row.contentType !== contentType) {
    return { success: false, queueId, error: "No matching draft with that id/contentType", status: 404 };
  }
  if (row.status !== "draft") {
    return {
      success: false,
      queueId,
      error: `Item ${queueId} is not an approvable draft (status: ${row.status})`,
      status: 400,
    };
  }

  const settingKey = CONTENT_BATCH_SCHEDULE_SETTING_KEY[contentType];
  const schedule = parseContentBatchSchedule(contentType, await getSetting(settingKey));
  const nowSec = Math.floor(Date.now() / 1000);
  const platform = row.platform as PublishPlatform;
  const occupied = (await getOccupiedQueueSlots(row.platform, contentType)).map(sqliteToUnixSec);

  for (let attempt = 0; attempt < 6; attempt++) {
    const next = await getNextAvailableSlot(platform, {}, { nowSec, occupied, schedule, contentType });
    if (!next) {
      return { success: false, queueId, error: "Aucun créneau libre (grille désactivée ou pleine)", status: 409 };
    }
    try {
      if (await approveContentBatchDraft(queueId, contentType, next.sqlite)) {
        return { success: true, queueId, scheduledAt: next.at, sqlite: next.sqlite };
      }
      return { success: false, queueId, error: "Draft was already approved or cancelled", status: 409 };
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        occupied.push(next.at);
        continue;
      }
      throw err;
    }
  }
  return { success: false, queueId, error: "Could not secure a free slot after retries", status: 409 };
}
