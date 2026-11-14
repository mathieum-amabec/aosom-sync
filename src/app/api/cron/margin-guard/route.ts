import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runMarginGuard } from "@/lib/margin-guard";

/**
 * GET /api/cron/margin-guard — daily, read-only: flags any active discount that can take more than MAX_DISCOUNT off an
 * item (or discounts that stack), and any active variant that loses money with the worst discount and the card fees,
 * as a dashboard notification. See src/lib/margin-guard.ts. Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "margin-guard",
      () => runMarginGuard(),
      (r) => `variants=${r.variants} withoutCost=${r.withoutCost} losses=${r.losses.length} worstDiscount=${Math.round(r.worstDiscount * 100)}% discountProblems=${r.discountProblems.length}`,
    );
    return NextResponse.json(
      { success: true, data: { ...result, losses: result.losses.slice(0, 100) } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/cron/margin-guard failed:", err);
    return NextResponse.json({ success: false, error: "margin-guard failed" }, { status: 500 });
  }
}
