import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runCategoryGuard } from "@/lib/category-guard";

/**
 * GET /api/cron/category-guard — daily, read-only: flags active products that no storefront
 * menu category shows, and import mappings pointing at deleted collections, as a dashboard
 * notification. See src/lib/category-guard.ts. Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "category-guard",
      () => runCategoryGuard(),
      (r) => `active=${r.activeProducts} menuCollections=${r.menuCollections} unreachable=${r.unreachable.length} staleMappings=${r.staleMappings.length}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/category-guard failed:", err);
    return NextResponse.json({ success: false, error: "category-guard failed" }, { status: 500 });
  }
}
