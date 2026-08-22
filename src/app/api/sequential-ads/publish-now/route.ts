import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getQueueItemById, claimQueueItem, markPublished, markFailed } from "@/lib/database";
import { publishQueueItem } from "@/lib/queue-publisher";

/**
 * POST /api/sequential-ads/publish-now  { queueId }
 *
 * Publish an approved sequential ad immediately instead of waiting for the hourly cron.
 * Same publish path as the scheduler — `publishQueueItem` — so a manual publish and a cron
 * publish produce byte-identical posts; only the trigger differs.
 *
 * Concurrency: `claimQueueItem` is the SAME atomic pending → publishing flip the cron uses
 * (`UPDATE ... WHERE id = ? AND status = 'pending'`). If the cron claimed this item a moment
 * ago, the claim returns false and we answer 409 rather than publishing a second copy. That
 * is the whole reason this route claims before publishing instead of just calling the
 * publisher: two paths now race for the same row.
 *
 * Only `pending` (approved) items are publishable. A draft has no reserved slot and has not
 * been approved by anyone, so it is refused with a message pointing at the approve action —
 * "publish now" must not double as a hidden approval.
 *
 * Admin-only; reviewers are read-only, matching the other sequential-ad routes.
 */
export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "`queueId` (positive integer) is required" }, { status: 400 });
  }
  const raw = (body as Record<string, unknown>)?.queueId;
  const queueId = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(queueId) || queueId <= 0) {
    return NextResponse.json({ error: "`queueId` (positive integer) is required" }, { status: 400 });
  }

  const item = await getQueueItemById(queueId);
  if (!item || item.contentType !== "sequential_ad") {
    return NextResponse.json({ error: "No sequential-ad queue item with that id" }, { status: 404 });
  }
  if (item.status === "draft") {
    return NextResponse.json(
      { error: "Approve this draft before publishing it" },
      { status: 400 },
    );
  }
  if (item.status !== "pending") {
    return NextResponse.json(
      { error: `Item ${queueId} is not publishable (status: ${item.status})` },
      { status: 400 },
    );
  }

  if (!(await claimQueueItem(queueId))) {
    return NextResponse.json(
      { error: "Item is already being published by the scheduler — refresh in a moment" },
      { status: 409 },
    );
  }

  try {
    const result = await publishQueueItem(item);
    await markPublished(queueId);
    return NextResponse.json({ success: true, queueId, postId: result.postId ?? null });
  } catch (err) {
    // Leave the row 'failed', not stuck in 'publishing' — a claimed row that never settles
    // is invisible to both the cron (it only reads 'pending') and to any retry.
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(queueId, message);
    return NextResponse.json({ error: `Publication échouée : ${message}` }, { status: 502 });
  }
}
