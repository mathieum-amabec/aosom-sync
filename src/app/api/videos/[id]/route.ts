import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  getVideoJob,
  updateVideoJob,
  deleteVideoJob,
  type VideoStatus,
} from "@/lib/database";

const STATUSES: VideoStatus[] = [
  "pending", "generating", "ready", "error", "approved", "rejected",
];

function parseId(idStr: string): number | null {
  const id = Number.parseInt(idStr, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * PATCH /api/videos/:id — update a job's status (approve/reject).
 *
 * Body: { status: VideoStatus }
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
  const id = parseId(idStr);
  if (id === null) {
    return NextResponse.json({ error: "Invalid video job id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string" || !(STATUSES as string[]).includes(status)) {
    return NextResponse.json({ error: `\`status\` must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
  }

  const job = await getVideoJob(id);
  if (!job) {
    return NextResponse.json({ error: "Video job not found" }, { status: 404 });
  }

  try {
    await updateVideoJob(id, { status });
    const updated = await getVideoJob(id);
    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error(`[API] PATCH /api/videos/${id} failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/videos/:id — remove a job.
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
  const id = parseId(idStr);
  if (id === null) {
    return NextResponse.json({ error: "Invalid video job id" }, { status: 400 });
  }

  const deleted = await deleteVideoJob(id);
  if (!deleted) {
    return NextResponse.json({ error: "Video job not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, id });
}
