/**
 * Approve / cancel a Studio Ameublo video: the one place that turns an `ameublo_test_videos`
 * row into a `publication_queue` row on the mascot grid (settings `ameublo_schedule`).
 *
 * Approving one language also schedules its other-language twin (same series, style and SKUs).
 * Approval is the OPERATOR's action only — nothing here is called by a cron or a generator.
 * A video lands on the next free slot of ITS language's share of the grid (FR and EN alternate
 * through the day) and the hourly publisher (/api/cron/publisher) does the rest.
 */
import {
  getAmeubloTestVideo,
  findAmeubloTwin,
  getOccupiedAmeubloSlots,
  getSetting,
  addToQueue,
  cancelPendingQueueItems,
  setAmeubloQueueId,
  QueueSlotTakenError,
  type AmeubloLang,
  type AmeubloTestVideo,
} from "@/lib/database";
import { ameubloScheduleForLang, getNextAvailableSlot, parseAmeubloSchedule, parseReactionSchedule } from "@/lib/publication-scheduler";
import { checkSequentialAdPrice } from "@/lib/sequential-ad-price";
import { stripSupplierBrands } from "@/lib/catalog-guard";

const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

export type AmeubloApproveResult =
  | { success: true; id: number; queueId: number; scheduledAt: string; twin?: AmeubloApproveResult }
  | { success: false; id: number; error: string; status: number };

/** Why a video may not be approved right now, or null when it can be. */
export function approvalBlocker(v: AmeubloTestVideo, force: boolean): string | null {
  if (!v.lang || !v.style) return "Vidéo d’une ancienne série (sans langue ni style) : non publiable.";
  if (!v.caption?.trim()) return "Légende manquante.";
  if (v.verdict === "bad") return "Marquée « À revoir » : retire d’abord ce verdict.";
  if (v.queue_id != null && v.queue_status && ["pending", "publishing", "published"].includes(v.queue_status)) {
    return v.queue_status === "published" ? "Déjà publiée." : "Déjà planifiée.";
  }
  if (v.qa_verdict === "fail" && !force) return "Le réviseur automatique a refusé cette vidéo (voir ses notes). Force l’approbation pour passer outre.";
  return null;
}

/**
 * Approve a video AND its other-language version in the same action: FR and EN go on the
 * schedule together, each on its own language's next free slot. The twin never blocks the
 * video asked for: if it can't be scheduled (QA fail, stale price...), the reason is in `twin`.
 */
export async function approveAmeubloVideo(id: number, opts: { force?: boolean } = {}): Promise<AmeubloApproveResult> {
  const res = await approveOne(id, opts);
  if (!res.success) return res;
  const v = await getAmeubloTestVideo(id);
  const twin = v ? await findAmeubloTwin(v) : null;
  if (twin) res.twin = await approveOne(twin.id, opts);
  return res;
}

async function approveOne(id: number, opts: { force?: boolean }): Promise<AmeubloApproveResult> {
  const v = await getAmeubloTestVideo(id);
  if (!v) return { success: false, id, error: "Vidéo introuvable.", status: 404 };
  const blocked = approvalBlocker(v, opts.force === true);
  if (blocked) return { success: false, id, error: blocked, status: 409 };
  const lang = v.lang as AmeubloLang;

  // The frame burns real prices: refuse a video whose prices moved since the render.
  const metadata: Record<string, unknown> = {
    source: "ameublo_studio",
    keepCaption: true,
    ameubloVideoId: v.id,
    style: v.style,
    lang,
    series: v.series,
    campaign: v.campaign,
    skus: v.skus,
    renderedPrices: v.prices,
  };
  const price = await checkSequentialAdPrice({ contentId: `ameublo:${v.id}`, metadata });
  if (!price.ok) return { success: false, id, error: price.reason!, status: 409 };

  // "Réaction" videos have their own grid (reaction_schedule, 1/day/page) and their own
  // occupancy, so they neither take slots from nor count against the other styles' grid.
  const grid = v.style === "reaction" ? "reaction" : "main";
  const schedule = ameubloScheduleForLang(
    grid === "reaction"
      ? parseReactionSchedule(await getSetting("reaction_schedule"))
      : parseAmeubloSchedule(await getSetting("ameublo_schedule")),
    lang,
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedAmeubloSlots(lang, grid)).map(sqliteToUnixSec);
  const contentId = `ameublo:${v.id}`;
  const payload = JSON.stringify({
    caption: stripSupplierBrands(v.caption!),
    brand: lang === "en" ? "furnish" : "ameublo",
    reelsVideoUrl: v.video_url,
  });

  for (let attempt = 0; attempt < 6; attempt++) {
    const slot = await getNextAvailableSlot("facebook", {}, { nowSec, occupied, schedule, contentType: "sequential_ad" });
    if (!slot) return { success: false, id, error: "Aucun créneau libre (horaire désactivé ou plein).", status: 409 };
    try {
      const queueId = await addToQueue({
        contentType: "sequential_ad",
        contentId,
        platform: "both",
        payload,
        scheduledAt: slot.sqlite,
        status: "pending",
        metadata,
      });
      await setAmeubloQueueId(v.id, queueId);
      return { success: true, id, queueId, scheduledAt: slot.sqlite };
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        occupied.push(slot.at);
        continue;
      }
      throw err;
    }
  }
  return { success: false, id, error: "Impossible de réserver un créneau après plusieurs essais.", status: 409 };
}

/** Approve several videos, alternating FR / EN so the first free slots of each language fill evenly. */
export async function bulkApproveAmeubloVideos(ids: number[], opts: { force?: boolean } = {}): Promise<AmeubloApproveResult[]> {
  const videos = (await Promise.all(ids.map((i) => getAmeubloTestVideo(i)))).filter((x): x is AmeubloTestVideo => x != null);
  const fr = videos.filter((x) => x.lang === "fr").map((x) => x.id);
  const en = videos.filter((x) => x.lang === "en").map((x) => x.id);
  const rest = ids.filter((i) => !fr.includes(i) && !en.includes(i));
  const order: number[] = [];
  for (let k = 0; k < Math.max(fr.length, en.length); k++) {
    if (k < fr.length) order.push(fr[k]);
    if (k < en.length) order.push(en[k]);
  }
  order.push(...rest);
  const out: AmeubloApproveResult[] = [];
  const doneAsTwin = new Map<number, AmeubloApproveResult>();
  for (const id of order) {
    const already = doneAsTwin.get(id);
    if (already) { out.push(already); continue; }
    const res = await approveAmeubloVideo(id, opts);
    out.push(res);
    if (res.success && res.twin) doneAsTwin.set(res.twin.id, res.twin);
  }
  return out;
}

/** Take a video off the schedule (pending → cancelled) and unlink it. */
export async function cancelAmeubloVideo(id: number): Promise<{ success: boolean; error?: string }> {
  const v = await getAmeubloTestVideo(id);
  if (!v) return { success: false, error: "Vidéo introuvable." };
  if (v.queue_status === "published") return { success: false, error: "Déjà publiée : impossible d’annuler." };
  if (v.queue_status === "publishing") return { success: false, error: "Publication en cours." };
  await cancelPendingQueueItems("sequential_ad", `ameublo:${id}`);
  await setAmeubloQueueId(id, null);
  return { success: true };
}
