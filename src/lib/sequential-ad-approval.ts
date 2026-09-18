/**
 * Shared slot-safe "approve one sequential-ad draft" logic, factored out of
 * /api/sequential-ads/approve so /api/sequential-ads/bulk-approve can reuse the exact
 * same retry-on-collision behavior instead of a second implementation.
 */
import {
  getQueueItemById,
  approveSequentialAdDraft,
  getOccupiedQueueSlots,
  getSetting,
  QueueSlotTakenError,
} from "@/lib/database";
import { getNextAvailableSlot, parseVideoSchedule } from "@/lib/publication-scheduler";

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

export type ApproveOneResult =
  | { success: true; queueId: number; scheduledAt: number }
  | { success: false; queueId: number; error: string; status: number };

/**
 * Approve a single sequential-ad draft (draft → pending), reserving a slot. Tries the
 * draft's own tentative slot first, then recomputes a free one (up to 6 attempts) if that
 * slot was taken since generation. Never throws on ordinary failure modes — every outcome
 * is a tagged result so a bulk caller can keep going through the rest of a batch.
 */
export async function approveOneSequentialAd(queueId: number): Promise<ApproveOneResult> {
  const row = await getQueueItemById(queueId);
  if (!row || row.contentType !== "sequential_ad") {
    return { success: false, queueId, error: "No sequential-ad queue item with that id", status: 404 };
  }
  if (row.status !== "draft") {
    return {
      success: false,
      queueId,
      error: `Item ${queueId} is not an approvable draft (status: ${row.status})`,
      status: 400,
    };
  }

  try {
    if (await approveSequentialAdDraft(queueId, row.scheduledAt)) {
      return { success: true, queueId, scheduledAt: sqliteToUnixSec(row.scheduledAt) };
    }
    return { success: false, queueId, error: "Draft was already approved or cancelled", status: 409 };
  } catch (err) {
    if (!(err instanceof QueueSlotTakenError)) throw err;
    // Slot taken since generation — fall through to recompute a free one.
  }

  const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots(row.platform, "sequential_ad")).map(sqliteToUnixSec);

  for (let attempt = 0; attempt < 6; attempt++) {
    const next = await getNextAvailableSlot("facebook", {}, {
      nowSec,
      occupied,
      schedule: videoSchedule,
      contentType: "sequential_ad",
    });
    if (!next) {
      return { success: false, queueId, error: "No free publication slot (schedule disabled or full)", status: 409 };
    }
    try {
      if (await approveSequentialAdDraft(queueId, next.sqlite)) {
        return { success: true, queueId, scheduledAt: next.at };
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
