import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { scheduleGuidePublication } from "@/lib/guide-scheduler";

/**
 * POST /api/guides/:id/approve — the ONLY code path that can schedule a guide page to go
 * live. Books the guide onto the next free slot of `guide_schedule` (same deferred-queue
 * mechanism as video/social — see guide-scheduler.ts) instead of publishing immediately: the
 * guide stays 'pending_review' with `scheduled_publish_at` set until the hourly
 * /api/cron/publisher drains the slot. Requires the guide to still be 'pending_review' and
 * not already scheduled — already-published, skipped, or already-scheduled rows are rejected.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idStr } = await params;
  const id = Number.parseInt(idStr, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid guide id" }, { status: 400 });
  }

  const result = await scheduleGuidePublication(id);
  if (!result.success) {
    if (result.status >= 500) {
      console.error(`[API] POST /api/guides/${id}/approve — scheduling failed:`, result.error);
    }
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true, scheduledAt: result.scheduledAt, sqlite: result.sqlite });
}
