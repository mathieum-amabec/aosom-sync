import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getSetting,
  getOccupiedQueueSlots,
  addToQueue,
  cancelPendingQueueItems,
  QueueSlotTakenError,
  type QueuePlatform,
} from "@/lib/database";
import { getNextAvailableSlot, parseVideoSchedule, parseSlideshowSettings } from "@/lib/publication-scheduler";
import { activeChannels, CHANNEL_META, VIDEO_RATIOS } from "@/lib/config";
import { buildSlideshow, isSlideshowTemplate, languageForBrand, type BuildSlideshowOptions } from "@/lib/slideshow/build";
import { getSlideshowCaption } from "@/lib/slideshow/captions";
import { SlideshowTemplate, type SlideshowBrand, type SlideshowRatio } from "@/lib/slideshow/types";
import type { SocialQueuePayload } from "@/lib/queue-publisher";

/**
 * POST /api/slideshow/generate
 *
 * Body: { template: SlideshowTemplate, opts?: object, dryRun?: boolean, enqueue?: boolean }
 *
 * - dryRun:true  → returns the render manifest (no image download, no ffmpeg, no Blob write).
 * - dryRun:false → renders the MP4 to the public Vercel Blob store.
 *   - enqueue:true → also enqueues it into publication_queue as content_type='video' with a
 *     `reelsVideoUrl` payload, so /api/cron/publisher publishes it as a Reel (re-captioned by
 *     Claude at publish time — see queue-publisher.ts). Platform comes from slideshow_settings,
 *     the slot from the (independent) video_schedule.
 *
 * Admin-only. Real renders are serialized (one at a time) — ffmpeg is heavy.
 */

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

/** Module-level lock: at most one real render in flight per function instance. */
let GENERATING = false;

/** Resolve the queue platform from a target + the brand's active channels (null if none match). */
function resolvePlatform(brand: SlideshowBrand, want: "facebook" | "instagram" | "both"): QueuePlatform | null {
  let fb = false;
  let ig = false;
  for (const key of activeChannels()) {
    const meta = CHANNEL_META[key];
    if (meta.brand !== brand) continue;
    if (meta.platform === "facebook") fb = true;
    else ig = true;
  }
  const useFb = (want === "facebook" || want === "both") && fb;
  const useIg = (want === "instagram" || want === "both") && ig;
  return useFb && useIg ? "both" : useFb ? "facebook" : useIg ? "instagram" : null;
}

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
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isSlideshowTemplate(b.template)) {
    return NextResponse.json(
      { error: `\`template\` must be one of ${Object.values(SlideshowTemplate).join(", ")}` },
      { status: 400 },
    );
  }
  const template = b.template;
  const dryRun = b.dryRun === true;
  const enqueue = b.enqueue === true;
  // Strip musicUrl: it would flow to `ffmpeg -i <musicUrl>` (arbitrary local-path / URL
  // read), and Module G has no need for caller-chosen music — the engine uses the bundled
  // royalty-free default. Force it undefined before it reaches buildSlideshow/renderSlideshow.
  const reqOpts: BuildSlideshowOptions = {
    ...((b.opts && typeof b.opts === "object" ? b.opts : {}) as BuildSlideshowOptions),
    musicUrl: undefined,
  };

  // Slideshow defaults (ratio + platform) come from the saved settings unless the
  // caller overrides them in opts.
  const slideshowSettings = parseSlideshowSettings(await getSetting("slideshow_settings"));
  const ratio: SlideshowRatio = reqOpts.ratio ?? slideshowSettings.default_ratio;
  if (!(VIDEO_RATIOS as readonly string[]).includes(ratio)) {
    return NextResponse.json(
      { error: `\`opts.ratio\` must be one of ${VIDEO_RATIOS.join(", ")} (got '${ratio}')` },
      { status: 400 },
    );
  }
  const brand: SlideshowBrand = reqOpts.brand ?? "ameublo";
  if (brand !== "ameublo" && brand !== "furnish") {
    return NextResponse.json({ error: "`opts.brand` must be 'ameublo' or 'furnish'" }, { status: 400 });
  }
  // Language ALWAYS follows the brand: the publisher re-derives the caption language from the
  // brand at publish time (ameublo → fr, furnish → en), so forcing it here keeps the on-frame
  // overlays and the published caption in the same language. A caller-supplied opts.language is
  // intentionally ignored to prevent that divergence.
  const language = languageForBrand(brand);
  const opts: BuildSlideshowOptions = { ...reqOpts, ratio, brand, language, dryRun };

  // ── Dry run: cheap, no lock, no upload, no enqueue ──
  if (dryRun) {
    try {
      const built = await buildSlideshow(template, opts);
      return NextResponse.json({ success: true, dryRun: true, manifest: built.result.manifest });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
  }

  // ── Real render: serialize (ffmpeg is heavy) ──
  if (GENERATING) {
    return NextResponse.json({ error: "A slideshow render is already in progress — retry shortly" }, { status: 429 });
  }
  GENERATING = true;
  try {
    let built;
    try {
      built = await buildSlideshow(template, opts);
    } catch (err) {
      // buildSlideshow throws on user-fixable input (invalid config, no eligible products,
      // REMIX without a prior set) — surface as 400, matching the dry-run path.
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    const blobUrl = built.result.blobUrl;
    if (!blobUrl) {
      return NextResponse.json({ error: "Render produced no blob URL" }, { status: 500 });
    }

    if (!enqueue) {
      return NextResponse.json({ success: true, blobUrl, durationSec: built.result.durationSec });
    }

    // ── Enqueue into publication_queue as a video Reel ──
    // Platform: optional per-request override (the panel's platform buttons),
    // else the saved slideshow default. Validated against VIDEO_PLATFORMS.
    const wantPlatform =
      typeof b.platform === "string" && (["facebook", "instagram", "both"] as string[]).includes(b.platform)
        ? (b.platform as "facebook" | "instagram" | "both")
        : slideshowSettings.platform;
    const platform = resolvePlatform(brand, wantPlatform);
    if (!platform) {
      return NextResponse.json(
        {
          error: `No active channel for brand '${brand}' matching slideshow platform '${slideshowSettings.platform}' — rendered but not queued`,
          blobUrl,
        },
        { status: 409 },
      );
    }

    const caption = getSlideshowCaption(template, language, built.items);
    const payload: SocialQueuePayload = { caption, brand, reelsVideoUrl: blobUrl };
    // Deterministic id so a repeat generation REPLACES the still-pending post for the same
    // template/ratio (+ SKU for SHOWCASE) instead of double-publishing near-identical Reels
    // (mirrors queue-reel's re-queue safety). The freshly rendered MP4's blob URL still
    // overwrites the payload, so the moved post points at the latest render.
    const discriminator = template === SlideshowTemplate.SHOWCASE && opts.sku ? `:${opts.sku}` : "";
    const contentId = `slideshow:${template}:${ratio}${discriminator}`;
    await cancelPendingQueueItems("video", contentId);

    // Slideshows share the video slot pool (content_type='video') and cadence (video_schedule).
    const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
    const nowSec = Math.floor(Date.now() / 1000);
    const occupied = (await getOccupiedQueueSlots(platform, "video")).map(sqliteToUnixSec);

    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await getNextAvailableSlot("facebook", {}, {
        nowSec,
        occupied,
        schedule: videoSchedule,
        contentType: "video",
      });
      if (!next) {
        return NextResponse.json(
          { error: "No free publication slot (schedule disabled or full) — rendered but not queued", blobUrl },
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
          blobUrl,
          durationSec: built.result.durationSec,
          queueId,
          brand,
          platform,
          scheduledAt: next.at,
          slot: next.sqlite,
        });
      } catch (err) {
        if (err instanceof QueueSlotTakenError) {
          occupied.push(next.at); // lost the race for this slot — recompute past it
          continue;
        }
        throw err;
      }
    }
    return NextResponse.json({ error: "Could not secure a free slot after retries", blobUrl }, { status: 409 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    GENERATING = false;
  }
}
