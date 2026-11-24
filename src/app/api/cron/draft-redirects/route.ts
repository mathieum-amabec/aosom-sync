import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runDraftRedirectReconcile } from "@/lib/draft-redirect";

/**
 * GET /api/cron/draft-redirects — safety net for the draft → 301 redirect.
 *
 * `updateShopifyProduct` already creates the redirect the moment a product goes DRAFT
 * (see draft-redirect.ts). This cron catches everything else: drafts made in the Shopify Admin
 * or via another path, the inline-budget overflow of a mass-draft run, transient failures.
 * Every customer-facing DRAFT product whose `/products/<handle>` has no redirect gets one to its
 * most specific collection. Never overrides an existing redirect.
 *
 * DRY-RUN unless `?apply=1` (the vercel.json schedule passes it). `?cap=N` overrides the per-run
 * creation cap (default RECONCILE_CAP). Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const apply = params.get("apply") === "1";
  const capRaw = Number(params.get("cap"));
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.min(capRaw, 400) : undefined;
  try {
    const result = await trackCron(
      apply ? "draft-redirects" : "draft-redirects-dryrun",
      () => runDraftRedirectReconcile({ apply, cap }),
      (r) =>
        `drafts=${r.drafts} eligible=${r.eligible} missing=${r.missing}` +
        (r.dryRun ? ` planned=${r.planned} [dry-run]` : ` created=${r.created}`) +
        ` failed=${r.failed}${r.deferred ? ` deferred=${r.deferred}` : ""}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/draft-redirects failed:", err);
    return NextResponse.json({ success: false, error: "draft-redirects failed" }, { status: 500 });
  }
}
