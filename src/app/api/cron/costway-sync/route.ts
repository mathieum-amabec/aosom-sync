import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runCostwaySync } from "@/lib/costway/sync";

/**
 * GET /api/cron/costway-sync — daily Costway catalogue refresh (feed → costway_products).
 * Catalogue only: never writes to Shopify, never touches the Aosom `products` table.
 * `?dryRun=1` parses + diffs without writing.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "costway-sync", msg, ...extra }));
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const start = Date.now();
  try {
    const data = await trackCron(
      "costway-sync",
      () => runCostwaySync({ dryRun }),
      (s) =>
        `${s.products} produits (${s.inStockVariants}/${s.variants} variantes en stock) · ` +
        `${s.inserted} nouveaux, ${s.contentUpdated} modifiés, ${s.volatileUpdated} stock/prix, ${s.removed} retirés` +
        (s.dryRun ? " · dry run" : ""),
    );
    log("done", { ...data });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("failed", { err: msg, duration_ms: Date.now() - start });
    return NextResponse.json({ success: false, error: msg, duration_ms: Date.now() - start }, { status: 500 });
  }
}
