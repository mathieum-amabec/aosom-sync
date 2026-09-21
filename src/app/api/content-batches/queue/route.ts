import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getContentBatchQueueItems,
  countContentBatchQueueItems,
  type QueueContentType,
} from "@/lib/database";

/**
 * GET /api/content-batches/queue?type=demand_gen_ext|before_after|assembly
 *
 * Rows in publication_queue for one of the 3 content-scale-chantier batch formats, newest
 * first — drives the /content-formats dashboard tabs. Mirrors /api/sequential-ads/queue,
 * generalized over `type` instead of one hardcoded content_type. Admin-only (reviewers
 * are read-only, same as sequential-ads and videos).
 */
const VALID_TYPES: QueueContentType[] = ["demand_gen_ext", "before_after", "assembly"];

export interface ContentBatchItem {
  id: number;
  contentType: QueueContentType;
  sku: string;
  status: string;
  scheduledAt: string;
  publishedAt: string | null;
  createdAt: string;
  payload: { sku?: string; productName?: string; blobUrl?: string; price?: number; ratio?: string; durationSec?: number };
}

function safePayload(raw: string): ContentBatchItem["payload"] {
  try {
    return JSON.parse(raw) as ContentBatchItem["payload"];
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

  const type = new URL(request.url).searchParams.get("type") as QueueContentType | null;
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: `\`type\` must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }

  const [rows, total] = await Promise.all([
    getContentBatchQueueItems(type),
    countContentBatchQueueItems(type),
  ]);
  const items: ContentBatchItem[] = rows.map((r) => ({
    id: r.id,
    contentType: r.contentType,
    sku: r.contentId,
    status: r.status,
    scheduledAt: r.scheduledAt,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    payload: safePayload(r.payload),
  }));
  return NextResponse.json({ items, total, type });
}
