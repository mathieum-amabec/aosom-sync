"use server";

import { revalidatePath } from "next/cache";
import { approveDraftDb, rejectDraftDb, getFacebookDraft, updateFacebookDraft, getScheduledDraftSlots } from "@/lib/database";
import { isAuthenticated } from "@/lib/auth";
import { publishText } from "@/lib/facebook-client";
import type { FacebookBrand } from "@/lib/facebook-client";
import { langsOf, findSlot, buildOccupancy } from "@/lib/draft-scheduler";

export async function approveDraft(draftId: number): Promise<{ error?: string; scheduledAt?: number }> {
  try {
    await approveDraftDb(draftId);

    // Auto-schedule content_template drafts onto the next free Mon/Wed/Fri 10:00 EST
    // (15:00 UTC) slot — 1 FR + 1 EN per slot. Product drafts stay 'approved' for
    // manual scheduling. Failure here must not undo the approval, so it's best-effort.
    let scheduledAt: number | undefined;
    try {
      const draft = await getFacebookDraft(draftId);
      if (draft && draft.triggerType === "content_template") {
        const langs = langsOf(draft.postText, draft.postTextEn);
        if (langs.fr || langs.en) {
          const occupancy = buildOccupancy(await getScheduledDraftSlots());
          const slot = findSlot(Math.floor(Date.now() / 1000), langs, occupancy);
          if (slot != null) {
            await updateFacebookDraft(draftId, { status: "scheduled", scheduled_at: slot });
            scheduledAt = slot;
          }
        }
      }
    } catch (schedErr) {
      console.error(`[approveDraft] auto-schedule failed for #${draftId}:`, schedErr);
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
