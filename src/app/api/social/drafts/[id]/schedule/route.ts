import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getFacebookDraft,
  updateFacebookDraft,
  addToQueue,
  cancelPendingQueueItems,
  QueueSlotTakenError,
} from "@/lib/database";
import { draftToQueueItems } from "@/lib/social-publisher";
import { activeChannels } from "@/lib/config";

/**
 * POST /api/social/drafts/:id/schedule
 *
 * Body: { scheduled_at: number }  // unix seconds, must be in the future
 *
 * Enqueues the draft into `publication_queue` at the chosen time so
 * `/api/cron/publisher` (hourly) publishes it. This NO LONGER writes a
 * 'scheduled' facebook_draft — the legacy `/api/cron/social-scheduled` cron is
 * retired, so a 'scheduled' row would never publish. Same queue path as
 * `POST /api/social {action:"approve"}`, with no double-publish.
 *
 * Re-schedule safe: cancels the draft's existing pending queue rows first, then
 * enqueues at the new slot, so changing the time moves the post (no duplicates).
 *
 * Implicit approval: scheduling is itself an approval act, so the draft is left
 * 'approved' (it no longer passes through a 'scheduled' state).
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
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
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

  const draft = await getFacebookDraft(id);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  // Allow scheduling from draft/approved/scheduled (re-schedule). Block terminal
  // and in-flight states so we never mutate a publish in progress.
  if (!(draft.status === "draft" || draft.status === "approved" || draft.status === "scheduled")) {
    return NextResponse.json(
      { error: `Cannot schedule a ${draft.status} draft` },
      { status: 409 },
    );
  }

  // Re-schedule: drop any existing pending queue rows for this draft so the new time
  // replaces the old one instead of stacking a second publish.
  await cancelPendingQueueItems("social", String(id));

  // unix sec → SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC), the shape addToQueue requires.
  const slotSqlite = new Date(scheduledAt * 1000).toISOString().slice(0, 19).replace("T", " ");
  // One queue item per active brand (caption + brand + images), mirroring the approve flow.
  const items = draftToQueueItems(draft, activeChannels());

  let queuedCount = 0;
  for (const item of items) {
    try {
      await addToQueue({
        contentType: "social",
        contentId: String(id),
        platform: item.platform,
        payload: JSON.stringify(item.payload),
        scheduledAt: slotSqlite,
      });
      queuedCount++;
    } catch (err) {
      // Operator picked this exact slot — if it's already taken on this platform, skip
      // that brand rather than silently shifting the post to a different time.
      if (err instanceof QueueSlotTakenError) continue;
      throw err;
    }
  }

  // Scheduling is an approval act; leave the draft 'approved' (no 'scheduled' state anymore).
  await updateFacebookDraft(id, { status: "approved" });

  return NextResponse.json({
    success: true,
    id,
    status: "approved",
    scheduled_at: scheduledAt,
    queued: queuedCount > 0,
    queuedCount,
  });
}

/**
 * DELETE /api/social/drafts/:id/schedule
 *
 * Unschedules a draft: cancels its pending `publication_queue` rows (freeing their
 * slots) and reverts the draft to 'draft'. Blocks terminal/in-flight states so we
 * never yank a publish in progress. Also clears any legacy `scheduled_at` left on
 * pre-migration rows.
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
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
  }

  const draft = await getFacebookDraft(id);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  // Only block in-flight/terminal states. A queued draft is 'approved' now (not 'scheduled').
  if (!(draft.status === "draft" || draft.status === "approved" || draft.status === "scheduled")) {
    return NextResponse.json(
      { error: `Cannot unschedule a ${draft.status} draft` },
      { status: 409 },
    );
  }

  const cancelled = await cancelPendingQueueItems("social", String(id));
  await updateFacebookDraft(id, {
    status: "draft",
    scheduled_at: null,
  });

  return NextResponse.json({ success: true, id, status: "draft", cancelled });
}
