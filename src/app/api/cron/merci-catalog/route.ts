import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { buildMerciCatalogue } from "@/lib/post-purchase/catalog";
import { replaceCandidates } from "@/lib/post-purchase/store";
import { cleanupExpiredMerciCodes } from "@/lib/post-purchase/discount";

/**
 * GET /api/cron/merci-catalog — daily, after the price sync: rebuilds the offre de remerciement's candidate catalogue
 * (active + published + in stock + photo + a 10 %/5 % tier at today's cost) and deletes MERCI codes that ended
 * over 2 days ago. `?dry=1` builds and counts without writing anything (no Turso write — not even cron tracking —,
 * no Shopify delete).
 * Protected by CRON_SECRET (Bearer). See src/lib/post-purchase/catalog.ts.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const run = async () => {
    const { products, candidates } = await buildMerciCatalogue();
    const written = dry ? 0 : await replaceCandidates(candidates);
    const cleanup = await cleanupExpiredMerciCodes({ dryRun: dry });
    const tiers = { p10: candidates.filter((c) => c.pct === 10).length, p5: candidates.filter((c) => c.pct === 5).length };
    return { dry, products, candidates: candidates.length, written, tiers, cleanup };
  };
  try {
    // A dry run writes nothing at all — not even the cron_runs tracking row.
    const result = dry
      ? await run()
      : await trackCron("merci-catalog", run, (r) => `products=${r.products} candidates=${r.candidates} written=${r.written} p10=${r.tiers.p10} p5=${r.tiers.p5} codesDeleted=${r.cleanup.deleted}`);
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/merci-catalog failed:", err);
    return NextResponse.json({ success: false, error: "merci-catalog failed" }, { status: 500 });
  }
}
