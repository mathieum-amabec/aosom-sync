import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getGbpPostById, updateGbpPostStatus } from "@/lib/database";

/** POST /api/gbp/posts/:id/reject — mark a pending post rejected (never publishes it). */
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
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  }

  const post = await getGbpPostById(id);
  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  if (post.status !== "pending_review") {
    return NextResponse.json({ error: `Wrong status: ${post.status}` }, { status: 409 });
  }

  await updateGbpPostStatus(id, "rejected");
  return NextResponse.json({ success: true });
}
