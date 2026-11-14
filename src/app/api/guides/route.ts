import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getGuidePages } from "@/lib/database";

/** GET /api/guides — list every pSEO guide (pending_review / skipped_empty / published),
 * including the full body_html so the dashboard can render the text without a Shopify
 * round-trip, and the 3-pass quality verdict for triage. */
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const guides = await getGuidePages();
    return NextResponse.json({ success: true, guides }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/guides failed:", err);
    return NextResponse.json({ success: false, error: "Failed to load guides" }, { status: 500 });
  }
}
