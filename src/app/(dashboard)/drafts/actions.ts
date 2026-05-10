"use server";

import { revalidatePath } from "next/cache";
import { approveDraftDb, rejectDraftDb } from "@/lib/database";

export async function approveDraft(draftId: number): Promise<{ error?: string }> {
  try {
    await approveDraftDb(draftId);
    revalidatePath("/drafts");
    return {};
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
