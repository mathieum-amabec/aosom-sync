import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { rescheduleGuidePublication, cancelGuideSchedule } from "@/lib/guide-scheduler";

/**
 * PATCH /api/guides/:id/schedule
 *
 * Body: { scheduled_at: number }  // unix seconds, must be in the future
 *
 * Lets an operator move an already-scheduled guide to a different time (POST
 * /api/guides/:id/approve books the auto-picked slot; this adjusts it). Cancels the existing
 * pending queue row and books the new one — mirrors POST /api/social/drafts/:id/schedule's
 * re-schedule-safe pattern. A manual pick does NOT walk forward on collision: if the chosen
 * slot is taken, this reports it back rather than silently shifting the time.
 */
export async function PATCH(
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const obj = body as { scheduled_at?: unknown };
  const scheduledAt = obj.scheduled_at;
  if (typeof scheduledAt !== "number" || !Number.isFinite(scheduledAt) || !Number.isInteger(scheduledAt)) {
    return NextResponse.json({ error: "`scheduled_at` must be a unix-seconds integer" }, { status: 400 });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (scheduledAt <= nowSec) {
    return NextResponse.json({ error: "`scheduled_at` must be in the future" }, { status: 400 });
  }

  // unix sec → SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC).
  const sqlite = new Date(scheduledAt * 1000).toISOString().slice(0, 19).replace("T", " ");
  const result = await rescheduleGuidePublication(id, sqlite);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ success: true, scheduledAt: result.scheduledAt, sqlite: result.sqlite });
}

/**
 * DELETE /api/guides/:id/schedule — cancels a guide's pending schedule (queue row +
 * scheduled_publish_at), reverting it to a plain unscheduled pending_review row so it shows
 * the "Approuver" action again.
 */
export async function DELETE(
  _request: Request,
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

  const result = await cancelGuideSchedule(id);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 409 });
  }
  return NextResponse.json({ success: true });
}
