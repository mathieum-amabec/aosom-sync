/**
 * GET /api/videos/:id/status — lightweight polling endpoint for the dashboard.
 *
 * Returns just the fields the "Générer" tab needs to drive its 3s poll while a
 * job is generating: { status, video_url, error_message }. Auth-gated like the
 * rest of /api/videos.
 */
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getVideoJob } from "@/lib/database";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: idStr } = await params;
  const id = Number.parseInt(idStr, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid video job id" }, { status: 400 });
  }

  const job = await getVideoJob(id);
  if (!job) {
    return NextResponse.json({ error: "Video job not found" }, { status: 404 });
  }

  return NextResponse.json({
    status: job.status,
    video_url: job.video_url,
    error_message: job.error_message,
  });
}
