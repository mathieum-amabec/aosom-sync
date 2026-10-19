import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runVariantPhotoGuard, type GuardMode } from "@/lib/variant-photo-guard";

/**
 * GET /api/cron/variant-photo-guard — daily: every colour of every multi-colour product shows its own photo (fixed
 * automatically from the feed, capped per run), and colour labels that contradict the supplier are reported. See
 * src/lib/variant-photo-guard.ts. `?mode=dry` plans without writing; `?max=N` changes the per-run cap.
 * Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const m = url.searchParams.get("mode");
  const mode: GuardMode | undefined = m === "dry" || m === "live" || m === "off" ? m : undefined;
  const maxRaw = Number(url.searchParams.get("max"));
  const maxFixes = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(Math.floor(maxRaw), 1000) : undefined;
  try {
    const result = await trackCron(
      "variant-photo-guard",
      () => runVariantPhotoGuard({ mode, maxFixes }),
      (r) => `${r.mode}: products=${r.multiColourProducts} fixed=${r.fixed} pending=${r.pending} failed=${r.failed.length} noSource=${r.noSource.length} labelIssues=${r.labelIssues.length}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/variant-photo-guard failed:", err);
    return NextResponse.json({ success: false, error: "variant-photo-guard failed" }, { status: 500 });
  }
}
