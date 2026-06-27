import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getQueueItemById,
  approveVideoDraft,
  cancelVideoDraft,
  getOccupiedQueueSlots,
  getSetting,
  QueueSlotTakenError,
} from "@/lib/database";
import { getNextAvailableSlot, parseVideoSchedule } from "@/lib/publication-scheduler";

/**
 * Approve / reject a generated slideshow video that is sitting in
 * publication_queue as a DRAFT (status='draft', content_type='video').
 *
 * POST   { queueId } → flip draft → pending, reserving a real slot. The publisher
 *                      (status='pending') can then publish it. Returns scheduledAt.
 * DELETE { queueId } → cancel the draft (status='cancelled').
 *
 * Admin-only (reviewers are read-only). Drafts don't reserve a slot, so approval
 * keeps the draft's tentative slot when it's still free and recomputes the next
 * free slot when it isn't (QueueSlotTakenError retry, mirroring the generate path).
 */

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

async function parseQueueId(request: Request): Promise<number | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const id = (body as Record<string, unknown>)?.queueId;
  const n = typeof id === "number" ? id : Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function requireAdmin(): Promise<NextResponse | null> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const queueId = await parseQueueId(request);
  if (queueId === null) {
    return NextResponse.json({ error: "`queueId` (positive integer) is required" }, { status: 400 });
  }

  const row = await getQueueItemById(queueId);
  if (!row || row.contentType !== "video") {
    return NextResponse.json({ error: "No video queue item with that id" }, { status: 404 });
  }
  if (row.status !== "draft") {
    return NextResponse.json(
      { error: `Item ${queueId} is not an approvable draft (status: ${row.status})` },
      { status: 400 },
    );
  }

  // 1. Try the draft's own (tentative) slot first.
  try {
    if (await approveVideoDraft(queueId, row.scheduledAt)) {
      return NextResponse.json({ success: true, queueId, scheduledAt: sqliteToUnixSec(row.scheduledAt) });
    }
    // rowsAffected 0 → another request already processed this draft.
    return NextResponse.json({ error: "Draft was already approved or cancelled" }, { status: 409 });
  } catch (err) {
    if (!(err instanceof QueueSlotTakenError)) throw err;
    // Slot taken since generation — fall through to recompute a free one.
  }

  // 2. Recompute the next free slot for this platform's video pool, retrying past
  //    any slot lost to a concurrent booking.
  const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots(row.platform, "video")).map(sqliteToUnixSec);

  for (let attempt = 0; attempt < 6; attempt++) {
    const next = await getNextAvailableSlot("facebook", {}, {
      nowSec,
      occupied,
      schedule: videoSchedule,
      contentType: "video",
    });
    if (!next) {
      return NextResponse.json({ error: "No free publication slot (schedule disabled or full)" }, { status: 409 });
    }
    try {
      if (await approveVideoDraft(queueId, next.sqlite)) {
        return NextResponse.json({ success: true, queueId, scheduledAt: next.at });
      }
      return NextResponse.json({ error: "Draft was already approved or cancelled" }, { status: 409 });
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        occupied.push(next.at); // lost the race for this slot — recompute past it
        continue;
      }
      throw err;
    }
  }
  return NextResponse.json({ error: "Could not secure a free slot after retries" }, { status: 409 });
}

export async function DELETE(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const queueId = await parseQueueId(request);
  if (queueId === null) {
    return NextResponse.json({ error: "`queueId` (positive integer) is required" }, { status: 400 });
  }

  const cancelled = await cancelVideoDraft(queueId);
  if (!cancelled) {
    return NextResponse.json({ error: "No draft video with that id to cancel" }, { status: 404 });
  }
  return NextResponse.json({ success: true, queueId });
}
