import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getPendingQueue, type PublicationQueueItem } from "@/lib/database";

/**
 * GET /api/queue — upcoming publication queue for the dashboard "File de publication"
 * panel. Auth-gated (session cookie). Reads `publication_queue` (status='pending',
 * oldest slot first) via getPendingQueue(), and returns a lean DTO per item:
 *   { id, scheduledAt, platform, contentType, status, preview, imageUrl }
 *
 * - `scheduledAt` is converted from the table's SQLite datetime TEXT (UTC,
 *   'YYYY-MM-DD HH:MM:SS') to unix seconds so the panel's formatSlot() works unchanged.
 * - `preview` is a truncated caption (social) or title (blog) extracted from the
 *   JSON `payload`. The full payload (up to 100KB) never leaves the server.
 *
 * Replaces the panel's old read of `/api/social?status=scheduled` (facebook_drafts),
 * which the Approve flow no longer feeds — see CLAUDE.md "Publication scheduling".
 */

const PREVIEW_MAX = 140;
// The dashboard panel only renders the first handful; cap the response so a large
// pending backlog can't bloat the payload. The grid is M/W/F-slotted so the real
// queue is small, but this bounds the worst case.
const MAX_ITEMS = 50;

export interface QueueItemDTO {
  id: number;
  scheduledAt: number | null; // unix seconds (UTC), or null if unparseable
  platform: PublicationQueueItem["platform"];
  contentType: PublicationQueueItem["contentType"];
  status: PublicationQueueItem["status"];
  preview: string;
  imageUrl: string | null;
}

/** SQLite datetime TEXT (UTC, 'YYYY-MM-DD HH:MM:SS') → unix seconds. null if unparseable. */
function sqliteUtcToUnix(text: string): number | null {
  const ms = Date.parse(text.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function truncate(s: string): string {
  const t = s.trim();
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX - 1).trimEnd() + "…" : t;
}

/** Only surface https image URLs to the dashboard (avoids mixed-content + referrer leakage). */
function httpsOnly(u: unknown): string | null {
  return typeof u === "string" && u.startsWith("https://") ? u : null;
}

/**
 * Pull a caption/title preview + thumbnail out of the JSON payload. Best-effort: a
 * malformed or unexpected payload yields empty preview/null image rather than throwing,
 * so one bad row never breaks the whole panel.
 */
function extractPreview(item: PublicationQueueItem): { preview: string; imageUrl: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(item.payload);
  } catch {
    return { preview: "", imageUrl: null };
  }
  if (!raw || typeof raw !== "object") return { preview: "", imageUrl: null };
  const o = raw as Record<string, unknown>;

  if (item.platform === "shopify_blog") {
    const title = typeof o.title === "string" ? o.title : "";
    const fi = o.featuredImage as Record<string, unknown> | undefined;
    return { preview: truncate(title), imageUrl: fi ? httpsOnly(fi.src) : null };
  }

  // social (facebook | instagram | both)
  const caption = typeof o.caption === "string" ? o.caption : "";
  let imageUrl = httpsOnly(o.imageUrl);
  if (!imageUrl && Array.isArray(o.imageUrls)) {
    for (const u of o.imageUrls) {
      imageUrl = httpsOnly(u);
      if (imageUrl) break;
    }
  }
  return { preview: truncate(caption), imageUrl };
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = (await getPendingQueue()).slice(0, MAX_ITEMS);
    const data: QueueItemDTO[] = items.map((item) => {
      const { preview, imageUrl } = extractPreview(item);
      return {
        id: item.id,
        scheduledAt: sqliteUtcToUnix(item.scheduledAt),
        platform: item.platform,
        contentType: item.contentType,
        status: item.status,
        preview,
        imageUrl,
      };
    });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[API] /api/queue GET failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to load publication queue" },
      { status: 500 },
    );
  }
}
