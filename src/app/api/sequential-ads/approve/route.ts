import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { cancelSequentialAdDraft } from "@/lib/database";
import { approveOneSequentialAd } from "@/lib/sequential-ad-approval";

/**
 * Approve / cancel a generated sequential ad sitting in publication_queue as a DRAFT
 * (status='draft', content_type='sequential_ad'). Same workflow as /api/slideshow/approve
 * for videos: sequential ads share the video slot schedule but their own slot pool
 * (contentType='sequential_ad'), so approving one never collides with a Reel draft.
 *
 * POST   { queueId } → draft → pending, reserving a slot (publisher then publishes it).
 * DELETE { queueId } → cancel the draft. Admin-only (reviewers are read-only).
 *
 * The slot-safe approval itself lives in sequential-ad-approval.ts, shared with
 * /api/sequential-ads/bulk-approve so both paths retry the exact same way on collision.
 */

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

  const result = await approveOneSequentialAd(queueId);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ success: true, queueId: result.queueId, scheduledAt: result.scheduledAt });
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
