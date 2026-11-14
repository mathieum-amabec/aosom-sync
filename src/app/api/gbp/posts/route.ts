import { NextResponse } from "next/server";
import { getGbpPosts } from "@/lib/database";

/** GET /api/gbp/posts?status=pending_review — list GBP posts for review. Session-protected
 * (not in proxy.ts PUBLIC_PATHS), same as every other dashboard API route. */
export async function GET(request: Request) {
  try {
    const status = new URL(request.url).searchParams.get("status") || undefined;
    const posts = await getGbpPosts(status);
    return NextResponse.json({ success: true, posts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/gbp/posts failed:", err);
    return NextResponse.json({ success: false, error: "Failed to load GBP posts" }, { status: 500 });
  }
}
