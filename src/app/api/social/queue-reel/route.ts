import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getDemandGenAssets,
  getSetting,
  getOccupiedQueueSlots,
  addToQueue,
  cancelPendingQueueItems,
  QueueSlotTakenError,
  type QueuePlatform,
} from "@/lib/database";
import { getNextAvailableSlot, parseVideoSchedule } from "@/lib/publication-scheduler";
import { activeChannels, CHANNEL_META } from "@/lib/config";
import type { SocialQueuePayload } from "@/lib/queue-publisher";

/**
 * POST /api/social/queue-reel
 *
 * Body: { sku, ratio, language, duration_sec?, caption? }
 *   - ratio: must be "9:16" — Reels are vertical; other aspect ratios are rejected
 *   - language: "fr" (Ameublo) | "en" (Furnish Direct)
 *   - duration_sec: optional; if a (sku, ratio) has several cuts, defaults to the longest
 *   - caption: optional override. Defaults to the asset's title_fr for fr; REQUIRED for en
 *     (video_demand_gen has no EN title, and we never post a French caption to the EN brand)
 *
 * Looks up the rendered video in `video_demand_gen`, builds a SocialQueuePayload with
 * `reelsVideoUrl` = blob_url (so the publisher posts a true Reel on both FB and IG —
 * see publishSocialPayload), cancels any prior pending rows for the same reel (re-queue
 * safety), and enqueues it into `publication_queue` on the next free publication slot.
 * `/api/cron/publisher` (hourly) drains and publishes it.
 */

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const sku = typeof o.sku === "string" ? o.sku.trim() : "";
  const ratio = typeof o.ratio === "string" ? o.ratio.trim() : "";
  const language = o.language;
  if (!sku) return NextResponse.json({ error: "`sku` is required" }, { status: 400 });
  if (ratio !== "9:16") {
    return NextResponse.json({ error: "`ratio` must be '9:16' — queue-reel publishes vertical Reels" }, { status: 400 });
  }
  if (language !== "fr" && language !== "en") {
    return NextResponse.json({ error: "`language` must be 'fr' or 'en'" }, { status: 400 });
  }
  const durationSec =
    typeof o.duration_sec === "number" && Number.isFinite(o.duration_sec) ? o.duration_sec : undefined;

  // Resolve the rendered asset from video_demand_gen.
  const matches = (await getDemandGenAssets()).filter((a) => a.sku === sku && a.ratio === ratio);
  if (matches.length === 0) {
    return NextResponse.json({ error: `No demand-gen asset for sku=${sku} ratio=${ratio}` }, { status: 404 });
  }
  const asset =
    durationSec !== undefined
      ? matches.find((a) => a.durationSec === durationSec)
      : [...matches].sort((a, b) => b.durationSec - a.durationSec)[0]; // longest cut by default
  if (!asset) {
    return NextResponse.json({ error: `No demand-gen asset for sku=${sku} ratio=${ratio} duration=${durationSec}s` }, { status: 404 });
  }

  const brand: "ameublo" | "furnish" = language === "en" ? "furnish" : "ameublo";
  const provided = typeof o.caption === "string" && o.caption.trim() !== "" ? o.caption.trim() : null;
  // title_fr is French — never use it as the caption for the EN (furnish) brand.
  const caption = provided ?? (language === "fr" ? asset.titleFr : null);
  if (!caption) {
    return NextResponse.json(
      {
        error:
          language === "en"
            ? "`caption` is required for English (video_demand_gen has no EN title)"
            : "No caption — asset has no title_fr; pass `caption`",
      },
      { status: 400 },
    );
  }

  // Platform = the brand's active channels (both FB+IG, or whichever is active).
  let fb = false;
  let ig = false;
  for (const key of activeChannels()) {
    const meta = CHANNEL_META[key];
    if (meta.brand !== brand) continue;
    if (meta.platform === "facebook") fb = true;
    else ig = true;
  }
  const platform: QueuePlatform | null = fb && ig ? "both" : fb ? "facebook" : ig ? "instagram" : null;
  if (!platform) {
    return NextResponse.json({ error: `No active channel for brand '${brand}'` }, { status: 400 });
  }

  // reelsVideoUrl drives a true Reel on both platforms (publishSocialPayload).
  const payload: SocialQueuePayload = { caption, brand, reelsVideoUrl: asset.blobUrl };
  const contentId = `reel:${sku}:${asset.ratio}:${asset.durationSec}`;

  // Re-queue safety: drop any existing pending rows for this exact reel so a repeat call
  // moves the post instead of double-publishing (mirrors /api/social/drafts/:id/schedule).
  await cancelPendingQueueItems("video", contentId);

  // Auto-schedule on the next free slot from the VIDEO schedule (independent of social
  // posts + blog). Occupancy is still per-platform (FB/IG), so a video and a social post
  // can't double-book the same platform slot — the QueueSlotTakenError retry skips past it.
  const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots(platform)).map(sqliteToUnixSec);

  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await getNextAvailableSlot("facebook", {}, { nowSec, occupied, schedule: videoSchedule });
    if (!next) {
      return NextResponse.json(
        { error: "No free publication slot (schedule disabled or full within the horizon)" },
        { status: 409 },
      );
    }
    try {
      const queueId = await addToQueue({
        contentType: "video",
        contentId,
        platform,
        payload: JSON.stringify(payload),
        scheduledAt: next.sqlite,
      });
      return NextResponse.json({
        success: true,
        queueId,
        sku,
        ratio: asset.ratio,
        durationSec: asset.durationSec,
        brand,
        platform,
        scheduledAt: next.at,
        slot: next.sqlite,
        blobUrl: asset.blobUrl,
      });
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        occupied.push(next.at); // lost the race for this slot — recompute past it
        continue;
      }
      throw err;
    }
  }
  return NextResponse.json({ error: "Could not secure a free slot after retries" }, { status: 409 });
}
