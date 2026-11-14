import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runApplianceLegalWarrantyGuard } from "@/lib/appliance-legal-warranty";

/**
 * GET /api/cron/appliance-warranty-guard — daily: tags new art. 38.1 appliances (fridges, freezers, ACs → 6 years;
 * washers, dryers, dishwashers → 5 years) so the theme shows the legal warranty near the price (LPC 38.8) and never
 * offers the paid Garantie Tranquillité on them. Additive only. `?dryRun=1` reports without writing.
 * Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = await trackCron(
      "appliance-warranty-guard",
      () => runApplianceLegalWarrantyGuard({ dryRun }),
      (r) => `${dryRun ? "DRY " : ""}active=${r.activeProducts} alreadyTagged=${r.alreadyTagged} tagged=${r.tagged.length} manualOnly=${r.manualOnly.length} failed=${r.failed.length}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/appliance-warranty-guard failed:", err);
    return NextResponse.json({ success: false, error: "appliance-warranty-guard failed" }, { status: 500 });
  }
}
