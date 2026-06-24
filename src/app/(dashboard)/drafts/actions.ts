"use server";

import { revalidatePath } from "next/cache";
import {
  approveDraftDb,
  rejectDraftDb,
  getFacebookDraft,
  updateFacebookDraft,
  getSetting,
  addToQueue,
  getOccupiedQueueSlots,
  QueueSlotTakenError,
} from "@/lib/database";
import { isAuthenticated } from "@/lib/auth";
import { publishText } from "@/lib/facebook-client";
import type { FacebookBrand } from "@/lib/facebook-client";
import { getNextAvailableSlot } from "@/lib/publication-scheduler";
import { draftToQueueItems } from "@/lib/social-publisher";
import { activeChannels } from "@/lib/config";

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
function sqliteToUnixSec(s: string): number {
  return Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);
}

export async function approveDraft(draftId: number): Promise<{ error?: string; scheduledAt?: number }> {
  try {
    await approveDraftDb(draftId);

    // Auto-schedule every approved draft into the publication queue — one item per active
    // brand (caption + brand + images via draftToQueueItems) on the next free slot from the
    // configurable `publication_schedule`. /api/cron/publisher drains the queue and publishes.
    // The draft itself stays 'approved' (the schedule now lives in publication_queue, not
    // facebook_drafts.status='scheduled' — the legacy social-scheduled cron is retired).
    // Best-effort: a failure here must not undo the approval. Slot collisions are rejected by
    // the queue's partial-unique index as QueueSlotTakenError, so retry past the now-taken slot
    // (mirrors /api/social approve).
    let scheduledAt: number | undefined;
    try {
      const draft = await getFacebookDraft(draftId);
      if (draft) {
        const settings = { publication_schedule: (await getSetting("publication_schedule")) ?? "" };
        const nowSec = Math.floor(Date.now() / 1000);
        const items = draftToQueueItems(draft, activeChannels());
        for (const item of items) {
          // Occupancy is scoped to the 'social' queue (independent slot pool / max_per_day —
          // social posts don't count video Reels). Convert SQLite-datetime → unix sec.
          const occupied = (await getOccupiedQueueSlots(item.platform, "social")).map(sqliteToUnixSec);
          for (let attempt = 0; attempt < 5; attempt++) {
            const next = await getNextAvailableSlot("facebook", settings, { nowSec, occupied, contentType: "social" });
            if (!next) break; // schedule disabled or no free slot within the horizon
            try {
              await addToQueue({
                contentType: "social",
                contentId: String(draftId),
                platform: item.platform,
                payload: JSON.stringify(item.payload),
                scheduledAt: next.sqlite,
              });
              scheduledAt = scheduledAt === undefined ? next.at : Math.min(scheduledAt, next.at);
              break;
            } catch (err) {
              if (err instanceof QueueSlotTakenError) {
                occupied.push(next.at); // lost the race for this slot — recompute past it
                continue;
              }
              throw err;
            }
          }
        }
      }
    } catch (schedErr) {
      console.error(`[approveDraft] auto-enqueue failed for #${draftId}:`, schedErr);
    }

    revalidatePath("/drafts");
    return scheduledAt != null ? { scheduledAt } : {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erreur inconnue" };
  }
}

export async function rejectDraft(draftId: number, notes: string): Promise<{ error?: string }> {
  if (!notes.trim()) return { error: "Les notes sont obligatoires pour rejeter un draft" };
  try {
    await rejectDraftDb(draftId, notes.trim());
    revalidatePath("/drafts");
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erreur inconnue" };
  }
}

export type PublishLanguage = "fr" | "en" | "both";

type PublishResult =
  | { success: true; publishedTo: string[]; fbPostIds: string[]; partialFailures?: { brand: string; error: string }[] }
  | { success: false; error: string };

export async function publishDraft(draftId: number, language: PublishLanguage = "both"): Promise<PublishResult> {
  if (!(await isAuthenticated())) return { success: false, error: "Non autorisé" };

  const draft = await getFacebookDraft(draftId);
  if (!draft) return { success: false, error: "Draft introuvable" };
  if (draft.status !== "approved") {
    return { success: false, error: `Draft must be 'approved' (current: ${draft.status})` };
  }

  const tasks: { brand: FacebookBrand; text: string }[] = [];
  if (language !== "en" && draft.postText?.trim()) tasks.push({ brand: "ameublo", text: draft.postText.trim() });
  if (language !== "fr" && draft.postTextEn?.trim()) tasks.push({ brand: "furnish", text: draft.postTextEn.trim() });
  if (tasks.length === 0) return { success: false, error: "Aucun texte à publier" };

  const results = await Promise.all(
    tasks.map(async ({ brand, text }) => {
      try {
        const { postId } = await publishText({ message: text, brand });
        return { success: true as const, brand, postId };
      } catch (e) {
        return { success: false as const, brand, error: e instanceof Error ? e.message : "Erreur inconnue" };
      }
    })
  );

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (succeeded.length === 0) {
    const errMsg = failed.map((f) => `${f.brand}: ${f.error}`).join("; ");
    await updateFacebookDraft(draftId, { publish_error: errMsg });
    revalidatePath("/drafts");
    return { success: false, error: errMsg };
  }

  const firstPostId = succeeded[0].postId as string;
  const partialError =
    failed.length > 0 ? `Partial: ${failed.map((f) => `${f.brand}: ${f.error}`).join("; ")}` : null;

  await updateFacebookDraft(draftId, {
    status: "published",
    facebook_post_id: firstPostId,
    published_at: Math.floor(Date.now() / 1000),
    publish_error: partialError,
  });
  revalidatePath("/drafts");

  return {
    success: true,
    publishedTo: succeeded.map((r) => r.brand),
    fbPostIds: succeeded.map((r) => r.postId as string),
    ...(failed.length > 0 && { partialFailures: failed.map((f) => ({ brand: f.brand, error: f.error as string })) }),
  };
}
