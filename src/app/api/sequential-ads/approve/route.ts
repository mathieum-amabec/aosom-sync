import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getQueueItemById,
  approveSequentialAdDraft,
  cancelSequentialAdDraft,
  getOccupiedQueueSlots,
  getSetting,
  QueueSlotTakenError,
} from "@/lib/database";
import { getNextAvailableSlot, parseVideoSchedule } from "@/lib/publication-scheduler";

/**
 * Approve / cancel a generated sequential ad sitting in publication_queue as a DRAFT
 * (status='draft', content_type='sequential_ad'). Same workflow as /api/slideshow/approve
 * for videos: sequential ads share the video slot schedule but their own slot pool
 * (contentType='sequential_ad'), so approving one never collides with a Reel draft.
 *
 * POST   { queueId } → draft → pending, reserving a slot (publisher then publishes it).
 * DELETE { queueId } → cancel the draft. Admin-only (reviewers are read-only).
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
  if (!row || row.contentType !== "sequential_ad") {
    return NextResponse.json({ error: "No sequential-ad queue item with that id" }, { status: 404 });
  }
  if (row.status !== "draft") {
    return NextResponse.json(
      { error: `Item ${queueId} is not an approvable draft (status: ${row.status})` },
      { status: 400 },
    );
  }

  // 1. Try the draft's own (tentative) slot first.
  try {
    if (await approveSequentialAdDraft(queueId, row.scheduledAt)) {
      return NextResponse.json({ success: true, queueId, scheduledAt: sqliteToUnixSec(row.scheduledAt) });
    }
    return NextResponse.json({ error: "Draft was already approved or cancelled" }, { status: 409 });
  } catch (err) {
    if (!(err instanceof QueueSlotTakenError)) throw err;
    // Slot taken since generation — fall through to recompute a free one.
  }

  // 2. Recompute the next free slot for this platform's sequential-ad pool.
  const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots(row.platform, "sequential_ad")).map(sqliteToUnixSec);

  for (let attempt = 0; attempt < 6; attempt++) {
    const next = await getNextAvailableSlot("facebook", {}, {
      nowSec,
      occupied,
      schedule: videoSchedule,
      contentType: "sequential_ad",
    });
    if (!next) {
      return NextResponse.json({ error: "No free publication slot (schedule disabled or full)" }, { status: 409 });
    }
    try {
      if (await approveSequentialAdDraft(queueId, next.sqlite)) {
        return NextResponse.json({ success: true, queueId, scheduledAt: next.at });
      }
      return NextResponse.json({ error: "Draft was already approved or cancelled" }, { status: 409 });
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        occupied.push(next.at);
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

  const cancelled = await cancelSequentialAdDraft(queueId);
  if (!cancelled) {
    return NextResponse.json({ error: "No draft sequential-ad with that id to cancel" }, { status: 404 });
  }
  return NextResponse.json({ success: true, queueId });
}
