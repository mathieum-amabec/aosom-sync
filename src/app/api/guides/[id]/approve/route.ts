import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getGuidePageById, markGuidePagePublished } from "@/lib/database";
import { publishBlogArticle } from "@/lib/shopify-blog";

/**
 * POST /api/guides/:id/approve — the ONLY code path that can make a guide page go live.
 * Flips the Shopify draft article to published:true (publishBlogArticle, same function the
 * blog auto-publisher uses) and records it locally. Requires the guide to still be
 * 'pending_review' — already-published or skipped rows are rejected.
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
    return NextResponse.json({ error: "Invalid guide id" }, { status: 400 });
  }

  const guide = await getGuidePageById(id);
  if (!guide) {
    return NextResponse.json({ error: "Guide not found" }, { status: 404 });
  }
  if (guide.status !== "pending_review") {
    return NextResponse.json({ error: `Wrong status: ${guide.status}` }, { status: 409 });
  }
  if (!guide.shopify_article_id || !guide.shopify_blog_id) {
    return NextResponse.json({ error: "Guide has no linked Shopify article" }, { status: 409 });
  }

  try {
    await publishBlogArticle(guide.shopify_blog_id, guide.shopify_article_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[API] POST /api/guides/${id}/approve — Shopify publish failed:`, message);
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  await markGuidePagePublished(id);
  return NextResponse.json({ success: true });
}
