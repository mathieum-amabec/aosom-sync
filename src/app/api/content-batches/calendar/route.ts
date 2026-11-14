import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getUpcomingContentBatchItems, type QueueContentType } from "@/lib/database";

/**
 * GET /api/content-batches/calendar
 *
 * The nearest upcoming *scheduled* (status='pending') rows across all 3 content-scale-
 * chantier video formats, soonest first — drives the "Prochains créneaux" strip at the top
 * of /content-formats. Read-only for both roles (admin and reviewer), unlike
 * /api/content-batches/approve — this is just a calendar view, not an approval action.
 */
export interface CalendarItem {
  id: number;
  contentType: QueueContentType;
  sku: string;
  scheduledAt: string;
  productName?: string;
}

function safeProductName(raw: string): string | undefined {
  try {
    return (JSON.parse(raw) as { productName?: string }).productName;
  } catch {
    return undefined;
  }
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await getUpcomingContentBatchItems(30);
  const items: CalendarItem[] = rows.map((r) => ({
    id: r.id,
    contentType: r.contentType,
    sku: r.contentId,
    scheduledAt: r.scheduledAt,
    productName: safeProductName(r.payload),
  }));
  return NextResponse.json({ items });
}
