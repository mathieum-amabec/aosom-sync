/**
 * pSEO guide deferred-publish scheduling. "Approuver" no longer calls publishBlogArticle
 * immediately — it books the guide onto the next free slot of `guide_schedule` (a
 * PublicationSchedule grid, same shape/mechanism as video/social — see
 * publication-scheduler.ts) by enqueuing a content_type='guide' / platform='shopify_guide'
 * publication_queue row. The existing hourly /api/cron/publisher drains it generically like
 * every other content_type — no dedicated guide-publish cron needed.
 */
import {
  getGuidePageById,
  addToQueue,
  getOccupiedQueueSlots,
  getSetting,
  cancelPendingQueueItems,
  scheduleGuidePagePublish,
  clearGuidePageSchedule,
  QueueSlotTakenError,
  type GuidePageRow,
} from "@/lib/database";
import { getNextAvailableSlot, parseContentBatchSchedule } from "@/lib/publication-scheduler";
import { isSqliteUtc } from "@/lib/draft-scheduler";

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

export interface GuideQueuePayload {
  guidePageId: number;
  blogId: number;
  articleId: string;
  /** Carried through so the consumer can set the collection's `custom.guide_url` metafield
   * (the "Guide d'achat" collection link — see Task C) without a second DB round trip. */
  shopifyCollectionId: string;
  shopifyHandle: string;
}

export type ScheduleGuideResult =
  | { success: true; scheduledAt: number; sqlite: string }
  | { success: false; error: string; status: number };

/** Caller must have already verified shopify_blog_id/shopify_article_id/shopify_handle are
 * non-null. */
function guidePayload(
  guide: GuidePageRow & { shopify_blog_id: number; shopify_article_id: string; shopify_handle: string },
): string {
  return JSON.stringify({
    guidePageId: guide.id,
    blogId: guide.shopify_blog_id,
    articleId: guide.shopify_article_id,
    shopifyCollectionId: guide.shopify_collection_id,
    shopifyHandle: guide.shopify_handle,
  } satisfies GuideQueuePayload);
}

/**
 * Approve a guide: compute the next free slot on `guide_schedule` and enqueue it. Retries on
 * a slot collision (mirrors approveOneContentBatchDraft / the social approve route) — rare
 * since the guide grid uses its own weekday/time pair, but the (platform, scheduled_at)
 * uniqueness constraint is global across every content_type, not scoped per-type.
 */
export async function scheduleGuidePublication(guideId: number): Promise<ScheduleGuideResult> {
  const guide = await getGuidePageById(guideId);
  if (!guide) return { success: false, error: "Guide not found", status: 404 };
  if (guide.status !== "pending_review") {
    return { success: false, error: `Wrong status: ${guide.status}`, status: 409 };
  }
  if (guide.scheduled_publish_at) {
    return { success: false, error: "Guide is already scheduled", status: 409 };
  }
  const { shopify_article_id: articleId, shopify_blog_id: blogId, shopify_handle: handle } = guide;
  if (!articleId || !blogId || !handle) {
    return { success: false, error: "Guide has no linked Shopify article", status: 409 };
  }

  const schedule = parseContentBatchSchedule("guide", await getSetting("guide_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots("shopify_guide", "guide")).map(sqliteToUnixSec);

  for (let attempt = 0; attempt < 6; attempt++) {
    const next = await getNextAvailableSlot("shopify_guide", {}, { nowSec, occupied, schedule, contentType: "guide" });
    if (!next) {
      return { success: false, error: "Aucun créneau libre (grille désactivée ou pleine)", status: 409 };
    }
    try {
      await addToQueue({
        contentType: "guide",
        contentId: String(guideId),
        platform: "shopify_guide",
        payload: guidePayload({ ...guide, shopify_article_id: articleId, shopify_blog_id: blogId, shopify_handle: handle }),
        scheduledAt: next.sqlite,
      });
      await scheduleGuidePagePublish(guideId, next.sqlite);
      return { success: true, scheduledAt: next.at, sqlite: next.sqlite };
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        occupied.push(next.at);
        continue;
      }
      throw err;
    }
  }
  return { success: false, error: "Could not secure a free slot after retries", status: 409 };
}

/**
 * Move an already-scheduled guide to an operator-chosen time. Cancels the existing pending
 * queue row and books a new one at `scheduledAt` — a deliberate manual pick, so unlike
 * scheduleGuidePublication this does NOT walk forward on collision; a taken slot is reported
 * back so the operator can choose a different time.
 */
export async function rescheduleGuidePublication(
  guideId: number,
  scheduledAt: string,
): Promise<ScheduleGuideResult> {
  if (!isSqliteUtc(scheduledAt)) {
    return { success: false, error: "scheduledAt must be 'YYYY-MM-DD HH:MM:SS' (UTC)", status: 400 };
  }
  const guide = await getGuidePageById(guideId);
  if (!guide) return { success: false, error: "Guide not found", status: 404 };
  if (guide.status !== "pending_review" || !guide.scheduled_publish_at) {
    return { success: false, error: "Guide is not currently scheduled", status: 409 };
  }
  const { shopify_article_id: articleId, shopify_blog_id: blogId, shopify_handle: handle } = guide;
  if (!articleId || !blogId || !handle) {
    return { success: false, error: "Guide has no linked Shopify article", status: 409 };
  }

  await cancelPendingQueueItems("guide", String(guideId));
  try {
    await addToQueue({
      contentType: "guide",
      contentId: String(guideId),
      platform: "shopify_guide",
      payload: guidePayload({ ...guide, shopify_article_id: articleId, shopify_blog_id: blogId, shopify_handle: handle }),
      scheduledAt,
    });
  } catch (err) {
    if (err instanceof QueueSlotTakenError) {
      return { success: false, error: `Créneau déjà pris : ${scheduledAt}`, status: 409 };
    }
    throw err;
  }
  await scheduleGuidePagePublish(guideId, scheduledAt);
  return { success: true, scheduledAt: sqliteToUnixSec(scheduledAt), sqlite: scheduledAt };
}

/** Cancel a guide's pending schedule, reverting it to a plain unscheduled pending_review row. */
export async function cancelGuideSchedule(guideId: number): Promise<{ success: boolean; error?: string }> {
  const guide = await getGuidePageById(guideId);
  if (!guide) return { success: false, error: "Guide not found" };
  if (!guide.scheduled_publish_at) return { success: false, error: "Guide is not scheduled" };

  await cancelPendingQueueItems("guide", String(guideId));
  await clearGuidePageSchedule(guideId);
  return { success: true };
}
