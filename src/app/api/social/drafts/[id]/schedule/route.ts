import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getFacebookDraft, updateFacebookDraft } from "@/lib/database";

/**
 * POST /api/social/drafts/:id/schedule
 *
 * Body: { scheduled_at: number }  // unix seconds, must be in the future
 *
 * Sets status='scheduled' + scheduled_at on the draft so the
 * `/api/cron/social-scheduled` cron (every 15 min, processScheduledDrafts)
 * picks it up at the requested time.
 *
 * Implicit approval: a 'draft' is moved straight to 'scheduled' without
 * passing through 'approved', because scheduling is itself an approval act.
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

  await updateFacebookDraft(id, {
    status: "scheduled",
    scheduled_at: scheduledAt,
  });

  return NextResponse.json({
    success: true,
    id,
    status: "scheduled",
    scheduled_at: scheduledAt,
  });
}

/**
 * DELETE /api/social/drafts/:id/schedule
 *
 * Clears scheduled_at and reverts status='scheduled' → 'draft' so the cron
 * stops considering it. Only allowed when the draft is currently scheduled.
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
  if (draft.status !== "scheduled") {
    return NextResponse.json(
      { error: `Draft is not scheduled (current: ${draft.status})` },
      { status: 409 },
    );
  }

  await updateFacebookDraft(id, {
    status: "draft",
    scheduled_at: null,
  });

  return NextResponse.json({ success: true, id, status: "draft" });
}
