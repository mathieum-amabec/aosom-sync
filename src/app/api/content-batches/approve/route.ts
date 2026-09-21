import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getQueueItemById,
  approveContentBatchDraft,
  cancelContentBatchDraft,
  rescheduleContentBatchDraft,
  QueueSlotTakenError,
  type QueueContentType,
} from "@/lib/database";

/**
 * Approve / schedule / cancel a demand_gen_ext | before_after | assembly draft sitting in
 * publication_queue. Generalizes /api/sequential-ads/approve + /schedule into one route
 * (Étape 5 of the content-scale chantier) rather than three near-identical files.
 *
 * POST { queueId, contentType }                 → approve NOW, at 24h from now (default slot).
 * POST { queueId, contentType, scheduledAt }     → approve/reschedule at an operator-chosen
 *                                                   ISO-8601 instant (ambiguity-free, same
 *                                                   contract as /api/sequential-ads/schedule).
 * DELETE { queueId, contentType }                → cancel the draft.
 *
 * Every path only ever reaches `status='pending'` — never `published`. Publication itself
 * stays gated behind the hourly /api/cron/publisher draining `pending` rows whose slot has
 * arrived, and behind THIS approval step existing at all: nothing here bypasses Mat approving
 * first. Admin-only; reviewers are read-only.
 */
const VALID_TYPES: QueueContentType[] = ["demand_gen_ext", "before_after", "assembly"];

function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function requireAdmin(): Promise<NextResponse | null> {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((await getSessionRole()) === "reviewer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

async function parseBody(request: Request): Promise<{ queueId: number; contentType: QueueContentType; scheduledAt?: string } | NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "`queueId` and `contentType` are required" }, { status: 400 });
  }
  const rawId = body?.queueId;
  const queueId = typeof rawId === "number" ? rawId : Number(rawId);
  if (!Number.isInteger(queueId) || queueId <= 0) {
    return NextResponse.json({ error: "`queueId` (positive integer) is required" }, { status: 400 });
  }
  const contentType = body?.contentType as QueueContentType;
  if (!VALID_TYPES.includes(contentType)) {
    return NextResponse.json({ error: `\`contentType\` must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }
  const rawAt = body?.scheduledAt;
  if (rawAt !== undefined && (typeof rawAt !== "string" || !rawAt.trim())) {
    return NextResponse.json({ error: "`scheduledAt`, if given, must be an ISO-8601 datetime" }, { status: 400 });
  }
  return { queueId, contentType, scheduledAt: rawAt as string | undefined };
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const parsed = await parseBody(request);
  if (parsed instanceof NextResponse) return parsed;
  const { queueId, contentType, scheduledAt: rawAt } = parsed;

  const item = await getQueueItemById(queueId);
  if (!item || item.contentType !== contentType) {
    return NextResponse.json({ error: "No matching draft with that id/contentType" }, { status: 404 });
  }

  let when: Date;
  if (rawAt) {
    when = new Date(rawAt);
    if (Number.isNaN(when.getTime())) {
      return NextResponse.json({ error: `\`scheduledAt\` is not a valid datetime: ${rawAt}` }, { status: 400 });
    }
    if (when.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "Cette date est déjà passée. Choisis une heure future." },
        { status: 400 },
      );
    }
    if (item.status !== "draft" && item.status !== "pending") {
      return NextResponse.json({ error: `Item ${queueId} cannot be scheduled (status: ${item.status})` }, { status: 400 });
    }
    const slot = toSqliteUtc(when);
    try {
      if (!(await rescheduleContentBatchDraft(queueId, contentType, slot))) {
        return NextResponse.json({ error: "Item changed status — refresh and try again" }, { status: 409 });
      }
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        return NextResponse.json({ error: "Ce créneau est déjà pris. Choisis une autre heure." }, { status: 409 });
      }
      throw err;
    }
    return NextResponse.json({ success: true, queueId, scheduledAt: slot });
  }

  // No explicit time: approve at a simple default (24h from now) — matches the picker's own
  // floor in the client, so "Approuver" without touching the date field lands somewhere sane.
  if (item.status !== "draft") {
    return NextResponse.json({ error: `Item ${queueId} is not an approvable draft (status: ${item.status})` }, { status: 400 });
  }
  when = new Date(Date.now() + 24 * 60 * 60 * 1000);
  for (let attempt = 0; attempt < 6; attempt++) {
    const slot = toSqliteUtc(when);
    try {
      if (await approveContentBatchDraft(queueId, contentType, slot)) {
        return NextResponse.json({ success: true, queueId, scheduledAt: slot });
      }
      return NextResponse.json({ error: "Draft was already approved or cancelled" }, { status: 409 });
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        when = new Date(when.getTime() + 60 * 60 * 1000); // try an hour later
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

  const parsed = await parseBody(request);
  if (parsed instanceof NextResponse) return parsed;
  const { queueId, contentType } = parsed;

  const cancelled = await cancelContentBatchDraft(queueId, contentType);
  if (!cancelled) {
    return NextResponse.json({ error: "No draft with that id/contentType to cancel" }, { status: 404 });
  }
  return NextResponse.json({ success: true, queueId });
}
