import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { publishPendingGbpPost } from "@/lib/gbp-publish";

/**
 * POST /api/gbp/posts/:id/approve — publish a pending GBP post for real.
 *
 * Body (optional): { confirmFirstPost?: boolean }
 *
 * The very first post this profile ever publishes through this pipeline requires
 * `confirmFirstPost: true` explicitly — the dashboard should surface a distinct "confirm
 * first real post" prompt rather than treating it as a routine approve click. Every
 * subsequent approve works without that flag.
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
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  }

  let confirmFirstPost = false;
  try {
    const body = (await request.json()) as { confirmFirstPost?: unknown };
    confirmFirstPost = body.confirmFirstPost === true;
  } catch {
    // no body / not JSON — confirmFirstPost stays false, which is the safe default
  }

  const outcome = await publishPendingGbpPost(id, { confirmFirstPost });

  if (outcome.ok) {
    return NextResponse.json({ success: true, postName: outcome.postName });
  }

  if (outcome.reason === "needs_first_post_confirmation") {
    return NextResponse.json(
      {
        success: false,
        error: "needs_first_post_confirmation",
        message: "Ceci sera le tout premier post GBP publié — relance avec { confirmFirstPost: true } pour confirmer.",
      },
      { status: 409 },
    );
  }
  if (outcome.reason === "not_found") {
    return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });
  }
  if (outcome.reason === "wrong_status") {
    return NextResponse.json({ success: false, error: `Wrong status: ${outcome.detail}` }, { status: 409 });
  }
  return NextResponse.json({ success: false, error: outcome.detail || "Publish failed" }, { status: 502 });
}
