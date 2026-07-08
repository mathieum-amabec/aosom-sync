import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getSequentialAdQueueItems } from "@/lib/database";

/**
 * GET /api/sequential-ads/queue
 *
 * Sequential-ad rows in publication_queue (content_type='sequential_ad'), newest
 * first — drives the /sequential-ads approval list. Each item exposes its status
 * and the display essentials from the payload (reelsVideoUrl, caption, brand) plus
 * the {style, campaign} metadata. Admin-only (reviewers are read-only).
 */
export interface SequentialAdQueueItem {
  id: number;
  content_id: string;
  status: string;
  scheduled_at: string;
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

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await getSequentialAdQueueItems();
  const items: SequentialAdQueueItem[] = rows.map((r) => ({
    id: r.id,
    content_id: r.contentId,
    status: r.status,
    scheduled_at: r.scheduledAt,
    created_at: r.createdAt,
    payload: safePayload(r.payload),
    style: typeof r.metadata?.style === "string" ? r.metadata.style : null,
    campaign: typeof r.metadata?.campaign === "string" ? r.metadata.campaign : null,
  }));
  return NextResponse.json({ items });
}
