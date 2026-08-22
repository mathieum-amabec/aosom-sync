import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getQueueItemById, rescheduleSequentialAd, QueueSlotTakenError } from "@/lib/database";

/**
 * POST /api/sequential-ads/schedule  { queueId, scheduledAt }
 *
 * Set an operator-chosen publication time for a sequential ad. `scheduledAt` is an ISO-8601
 * instant WITH an offset (the client sends `new Date(localInput).toISOString()`), because a
 * bare "2026-08-20T14:00" is ambiguous — the browser is in America/Montreal and the queue
 * stores UTC, so parsing a naked local string on the server would silently shift the post by
 * four or five hours depending on DST.
 *
 * Works on `draft` (approve at a chosen time) and on `pending` (move an already-scheduled
 * ad); `rescheduleSequentialAd` refuses every other status.
 *
 * The hourly publisher already honours this: `getNextPending` selects
 * `status = 'pending' AND scheduled_at <= datetime('now')`, so a future slot simply is not
 * picked up until it arrives. Nothing in the cron needed to change.
 *
 * Admin-only; reviewers are read-only.
 */

/** JS Date → SQLite UTC text ('YYYY-MM-DD HH:MM:SS'), the queue's storage format. */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "`queueId` and `scheduledAt` are required" }, { status: 400 });
  }

  const rawId = body?.queueId;
  const queueId = typeof rawId === "number" ? rawId : Number(rawId);
  if (!Number.isInteger(queueId) || queueId <= 0) {
    return NextResponse.json({ error: "`queueId` (positive integer) is required" }, { status: 400 });
  }

  const rawAt = body?.scheduledAt;
  if (typeof rawAt !== "string" || !rawAt.trim()) {
    return NextResponse.json({ error: "`scheduledAt` (ISO-8601 datetime) is required" }, { status: 400 });
  }
  const when = new Date(rawAt);
  if (Number.isNaN(when.getTime())) {
    return NextResponse.json({ error: `\`scheduledAt\` is not a valid datetime: ${rawAt}` }, { status: 400 });
  }
  // A past slot would be published on the very next cron tick, which is "publish now" wearing
  // a scheduling costume. Refuse it and point at the route that actually does that, so an
  // operator who fat-fingers a date does not get a surprise immediate post.
  if (when.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Cette date est déjà passée. Utilise « Publier maintenant » pour publier tout de suite." },
      { status: 400 },
    );
  }

  const item = await getQueueItemById(queueId);
  if (!item || item.contentType !== "sequential_ad") {
    return NextResponse.json({ error: "No sequential-ad queue item with that id" }, { status: 404 });
  }
  if (item.status !== "draft" && item.status !== "pending") {
    return NextResponse.json(
      { error: `Item ${queueId} cannot be rescheduled (status: ${item.status})` },
      { status: 400 },
    );
  }

  const slot = toSqliteUtc(when);
  try {
    if (!(await rescheduleSequentialAd(queueId, slot))) {
      return NextResponse.json({ error: "Item changed status — refresh and try again" }, { status: 409 });
    }
  } catch (err) {
    if (err instanceof QueueSlotTakenError) {
      return NextResponse.json(
        { error: "Ce créneau est déjà pris par une autre pub. Choisis une autre heure." },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ success: true, queueId, scheduledAt: slot });
}
