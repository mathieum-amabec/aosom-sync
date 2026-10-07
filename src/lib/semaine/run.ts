/**
 * One run = one post for one slot of one day. Called by /api/cron/semaine twice a day, an hour or
 * two before the 10:00 / 15:00 (Toronto) publication slots, so every check is fresh at post time.
 *
 *   kill switch → today's slot → pick (planned format, then fallbacks) → captions (validated and
 *   judged) → queue one item per brand → remember the products (cooldown) → report skips.
 *
 * Nothing here ever posts directly: the items go through `publication_queue` and the existing
 * publisher cron, which also gives retries and the failed-item alerts.
 */
import { getSetting, addToQueue, cancelPendingQueueItems, createNotification, QueueSlotTakenError, type FacebookDraft } from "@/lib/database";
import { enumerateSlots, parsePublicationSchedule } from "@/lib/publication-scheduler";
import { toSqliteUtc } from "@/lib/draft-scheduler";
import { activeChannels } from "@/lib/config";
import { draftToQueueItems } from "@/lib/social-publisher";
import { buildCaptions, defaultTextGen, type TextGen } from "./caption";
import { FALLBACKS, PICKERS, localDay, plannedFormat, type PickCtx } from "./formats";
import { getPost, recentSkus, savePost } from "./store";
import type { FormatId, PlannedPost, RunResult, SlotName } from "./types";

export const KILL_SWITCH_SETTING = "semaine_enabled";
/** SKUs stay out of new posts for this long. */
export const COOLDOWN_DAYS = 21;
const MAX_FORMAT_ATTEMPTS = 3; // formats tried per slot (each gets two product picks)

export interface RunDeps {
  getSetting: (key: string) => Promise<string | null>;
  picker: (format: FormatId, ctx: PickCtx) => Promise<PlannedPost | null>;
  gen: TextGen;
  recentSkus: (days: number) => Promise<Set<string>>;
  notify: (title: string, message: string) => Promise<unknown>;
}

const defaultDeps: RunDeps = {
  getSetting: (k) => getSetting(k),
  picker: (f, ctx) => PICKERS[f](ctx),
  gen: defaultTextGen,
  recentSkus,
  notify: (title, message) => createNotification("warning", title, message),
};

export interface RunOpts {
  slot: SlotName;
  now?: Date;
  /** Build everything but queue nothing and write nothing (preview). Ignores the kill switch. */
  dryRun?: boolean;
  /** Replace a day's earlier skipped/failed attempt. A queued slot is never replaced. */
  force?: boolean;
}

/** Today's publication slot for this run: the first slot of the day (morning) or the last (afternoon). */
async function todaysSlot(settings: (k: string) => Promise<string | null>, day: string, slot: SlotName, nowSec: number): Promise<number | null> {
  const schedule = parsePublicationSchedule(await settings("publication_schedule"));
  // Enumerate from a day ago so BOTH of today's slots are in the list even when one already passed;
  // otherwise "the first slot of today" would silently become the afternoon one.
  const today = enumerateSlots(schedule, nowSec - 86_400, 4).filter((s) => localDay(new Date(s * 1000)).date === day);
  if (today.length === 0) return null;
  const sec = slot === "morning" ? today[0] : today[today.length - 1];
  return sec > nowSec ? sec : null;
}

export async function runSemaine(opts: RunOpts, deps: RunDeps = defaultDeps): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const day = localDay(now);
  const base = { localDate: day.date, slot: opts.slot };
  const skip = async (reason: string, notify = false): Promise<RunResult> => {
    if (!opts.dryRun && reason !== "disabled") await savePost({ localDate: day.date, slot: opts.slot, status: "skipped", reason });
    if (notify && !opts.dryRun) await deps.notify(`La semaine Ameublo: ${opts.slot === "morning" ? "10 h" : "15 h"} sautée`, `${day.date}: ${reason}`);
    return { status: "skipped", reason, ...base };
  };

  if (!opts.dryRun && (await deps.getSetting(KILL_SWITCH_SETTING)) !== "1") return { status: "skipped", reason: "disabled", ...base };

  // A preview touches nothing: no table creation, no history read.
  const existing = opts.dryRun ? null : await getPost(day.date, opts.slot);
  if (existing?.status === "queued") return { status: "skipped", reason: "already_queued", ...base };
  if (existing && !opts.force && existing.status === "failed") return { status: "skipped", reason: "failed_earlier (relance avec force)", ...base };

  const slotSec = await todaysSlot(deps.getSetting, day.date, opts.slot, Math.floor(now.getTime() / 1000));
  if (slotSec == null) return skip("créneau du jour déjà passé ou absent de l'horaire");

  const ctx: PickCtx = { day, skip: opts.dryRun ? new Set<string>() : await deps.recentSkus(COOLDOWN_DAYS) };
  const planned = plannedFormat(day, opts.slot);
  const order = [planned, ...FALLBACKS.filter((f) => f !== planned && (opts.slot === "afternoon" ? f === "vedette" : true))].slice(0, MAX_FORMAT_ATTEMPTS);
  const why: string[] = [];

  // Each format gets two tries: when its captions are rejected, the same format is rebuilt without
  // those products (a single-product afternoon post would otherwise retry the very same product).
  const attempts = order.flatMap((f) => [f, f]);
  let lastFormat: FormatId | null = null;
  for (const format of attempts) {
    if (lastFormat === format && why.at(-1)?.startsWith(`${format}: pas assez`)) continue; // nothing left to retry
    lastFormat = format;
    const plan = await deps.picker(format, ctx);
    if (!plan) {
      why.push(`${format}: pas assez de produits vérifiés`);
      continue;
    }
    const built = await buildCaptions(plan, deps.gen);
    if (!built.ok) {
      why.push(`${format}: ${built.reason}`);
      for (const p of plan.products) ctx.skip.add(p.sku);
      continue;
    }
    const skus = plan.products.map((p) => p.sku);
    const imageUrls = plan.products.map((p) => p.imageUrl);
    if (opts.dryRun) return { status: "dry_run", ...base, format, skus, captions: built.captions, imageUrls, scheduledAt: toSqliteUtc(slotSec) };

    const draft = { id: 0, sku: skus[0], triggerType: "semaine", language: "FR", postText: built.captions.fr, postTextEn: built.captions.en, imageUrls, imageUrl: imageUrls[0] } as unknown as FacebookDraft;
    const items = draftToQueueItems(draft, activeChannels());
    if (items.length === 0) return skip("aucun canal actif", true);
    const scheduledAt = toSqliteUtc(slotSec);
    const queueIds: number[] = [];
    const contentIds: string[] = [];
    try {
      for (const it of items) {
        const contentId = `semaine:${day.date}:${opts.slot}:${it.payload.brand}`;
        queueIds.push(await addToQueue({
          contentType: "social", contentId, platform: it.platform, payload: JSON.stringify(it.payload), scheduledAt,
          metadata: { source: "semaine", format, slot: opts.slot, localDate: day.date, skus },
        }));
        contentIds.push(contentId);
      }
    } catch (err) {
      for (const id of contentIds) await cancelPendingQueueItems("social", id); // never leave one brand queued alone
      if (err instanceof QueueSlotTakenError) return skip(`créneau ${scheduledAt} déjà occupé par une autre publication`, true);
      throw err;
    }
    await savePost({ ...base, format, skus, status: "queued", queueIds, captionFr: built.captions.fr, scheduledAt });
    return { status: "queued", ...base, format, skus, queueIds, scheduledAt, captions: built.captions, imageUrls };
  }

  return skip(`aucun format prêt (${why.join(" · ")})`, true);
}
