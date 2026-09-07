import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getSequentialAdQueueItems,
  getSequentialAdCampaigns,
  countSequentialAdQueueItems,
} from "@/lib/database";

/**
 * GET /api/sequential-ads/queue[?campaign=<name>]
 *
 * Sequential-ad rows in publication_queue (content_type='sequential_ad'), newest
 * first — drives the /sequential-ads approval list. Each item exposes its status
 * and the display essentials from the payload (reelsVideoUrl, caption, brand) plus
 * the {style, campaign} metadata. Admin-only (reviewers are read-only).
 *
 * `campaign` filters in SQL and lifts the page cap, so selecting a campaign shows ALL of
 * it. Without it the list returns the 200 most recent. `campaigns` is computed over every
 * non-cancelled row, not over the returned page — the dropdown must offer the campaigns the
 * cap is hiding, or the operator has no way to reach them. `total` lets the UI say plainly
 * when it is showing a subset instead of silently truncating.
 */
export interface SequentialAdQueueItem {
  id: number;
  content_id: string;
  status: string;
  scheduled_at: string;
  /**
   * When the ad actually went out, or null while it has not. Distinct from `scheduled_at`,
   * which is only the PLANNED slot: "Publier maintenant" posts immediately and leaves the
   * slot untouched, so a published ad routinely carries a scheduled_at still in the future.
   * The card must read this field, not the slot, or it reports a publish that already
   * happened as if it were still days away.
   */
  published_at: string | null;
  created_at: string;
  payload: { reelsVideoUrl?: string; caption?: string; brand?: string };
  style: string | null;
  campaign: string | null;
}

/** Pull just the display essentials out of the JSON payload (never throws). */
function safePayload(raw: string): SequentialAdQueueItem["payload"] {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      reelsVideoUrl: typeof o.reelsVideoUrl === "string" ? o.reelsVideoUrl : undefined,
      caption: typeof o.caption === "string" ? o.caption : undefined,
      brand: typeof o.brand === "string" ? o.brand : undefined,
    };
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = new URL(request.url).searchParams.get("campaign");
  const campaign = raw && raw !== "all" ? raw : null;
  const [rows, campaigns, total] = await Promise.all([
    getSequentialAdQueueItems(undefined, campaign),
    getSequentialAdCampaigns(),
    countSequentialAdQueueItems(campaign),
  ]);
  const items: SequentialAdQueueItem[] = rows.map((r) => ({
    id: r.id,
    content_id: r.contentId,
    status: r.status,
    scheduled_at: r.scheduledAt,
    published_at: r.publishedAt ?? null,
    created_at: r.createdAt,
    payload: safePayload(r.payload),
    style: typeof r.metadata?.style === "string" ? r.metadata.style : null,
    campaign: typeof r.metadata?.campaign === "string" ? r.metadata.campaign : null,
  }));
  return NextResponse.json({ items, campaigns, total, campaign });
}
