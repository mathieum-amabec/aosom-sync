import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getVideoQueueItems } from "@/lib/database";

/**
 * GET /api/slideshow/queue
 *
 * Video rows in publication_queue (content_type='video'), newest first — drives
 * the /videos approval list. Each item exposes its status (draft / pending /
 * publishing / published / failed / cancelled) and the parsed payload essentials
 * (reelsVideoUrl, caption, brand) so the UI can preview + approve.
 *
 * Admin-only (reviewers are read-only and can't drive publication).
 */
export interface VideoQueueItem {
  id: number;
  content_id: string;
  status: string;
  scheduled_at: string;
  created_at: string;
  payload: { reelsVideoUrl?: string; caption?: string; brand?: string };
}

/** Pull just the display essentials out of the JSON payload (never throws). */
function safePayload(raw: string): VideoQueueItem["payload"] {
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

  const rows = await getVideoQueueItems();
  const items: VideoQueueItem[] = rows.map((r) => ({
    id: r.id,
    content_id: r.contentId,
    status: r.status,
    scheduled_at: r.scheduledAt,
    created_at: r.createdAt,
    payload: safePayload(r.payload),
  }));
  return NextResponse.json({ items });
}
