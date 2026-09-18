import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getQueueItemById } from "@/lib/database";
import { approveOneSequentialAd } from "@/lib/sequential-ad-approval";
import { checkSequentialAdQuality } from "@/lib/sequential-ad-guard";

/**
 * POST /api/sequential-ads/bulk-approve
 *
 * Approve several sequential-ad drafts in one request, each gated by the automatic
 * quality check (sequential-ad-guard.ts) before it's allowed through — built to unblock
 * the July-September 2026 backlog of drafts that piled up because the only approval path
 * was one row at a time (see /sequential-ads). Takes an EXPLICIT list of queue ids —
 * never "approve every draft" — the operator selects the batch via the UI's checkboxes.
 *
 * Body: { queueIds: number[] }
 * Response: { approved: [{ id, scheduledAt }], skipped: [{ id, reasons }] }
 *
 * Processes ids in series (not Promise.all) with a small delay between each: every
 * approval competes for the same sequential-ad slot pool, and the existing single-item
 * retry logic already assumes one caller at a time isn't racing another approval from the
 * very same request.
 */

const BETWEEN_ITEMS_MS = process.env.NODE_ENV === "test" ? 0 : 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BulkApproveBody {
  queueIds: number[];
}

async function parseBody(request: Request): Promise<BulkApproveBody | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const ids = (body as Record<string, unknown>)?.queueIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const parsed = ids.map((id) => (typeof id === "number" ? id : Number(id)));
  if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return { queueIds: parsed };
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await parseBody(request);
  if (!body) {
    return NextResponse.json({ error: "`queueIds` (non-empty array of positive integers) is required" }, { status: 400 });
  }
  // Hard cap so a mis-clicked "select all" can't fire hundreds of sequential slot lookups
  // in one request — matches the ~100-row scale of the actual backlog with headroom.
  if (body.queueIds.length > 150) {
    return NextResponse.json({ error: "Too many ids in one batch (max 150) — split into smaller batches" }, { status: 400 });
  }

  const approved: Array<{ id: number; scheduledAt: number }> = [];
  const skipped: Array<{ id: number; reasons: string[] }> = [];

  for (const id of body.queueIds) {
    const row = await getQueueItemById(id);
    if (!row || row.contentType !== "sequential_ad") {
      skipped.push({ id, reasons: ["no sequential-ad queue item with that id"] });
      continue;
    }
    if (row.status !== "draft") {
      skipped.push({ id, reasons: [`not a draft (status: ${row.status})`] });
      continue;
    }

    let payload: { caption?: string; reelsVideoUrl?: string } = {};
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      // fall through with empty payload — the guard will flag the missing caption/url
    }

    const quality = await checkSequentialAdQuality({
      contentId: row.contentId,
      caption: payload.caption,
      reelsVideoUrl: payload.reelsVideoUrl,
    });
    if (!quality.passes) {
      skipped.push({ id, reasons: quality.reasons });
      continue;
    }

    const result = await approveOneSequentialAd(id);
    if (result.success) {
      approved.push({ id, scheduledAt: result.scheduledAt });
    } else {
      skipped.push({ id, reasons: [result.error] });
    }

    await sleep(BETWEEN_ITEMS_MS);
  }

  return NextResponse.json({ approved, skipped });
}
