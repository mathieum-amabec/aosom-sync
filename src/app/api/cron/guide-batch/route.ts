import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { createNotification, getSetting, setSetting } from "@/lib/database";
import { generatePilotGuides, getGuideCoverageStatus } from "@/lib/subcategory-guide-generator";

/**
 * GET /api/cron/guide-batch — weekly pSEO subcategory guide batch (Phase 1 growth plan).
 *
 * Generates up to WEEKLY_BATCH_SIZE new guides among the real 'sub' subcategories
 * (collection_mappings) not yet covered by any guide_pages row, through the full pipeline
 * (generation → fact-check → quality/tone judge → real product images → JSON-LD). Every guide
 * is created as a Shopify draft (published:false, guaranteed by createBlogArticle) — this cron
 * has no code path that can publish anything.
 *
 * STOP CONDITION: once every 'sub' subcategory has a guide_pages row (generated OR
 * permanently skipped for a data reason), generatePilotGuides naturally returns zero
 * candidates — no Claude/Shopify calls happen, this becomes a single cheap DB read. A
 * one-time "coverage complete" notification fires the first time that's detected (guarded by
 * the `guide_batch_complete_notified` setting so it doesn't repeat every week after).
 *
 * IMPORTANT — what "stops" actually means: Vercel crons are static entries in vercel.json: a
 * running function cannot remove its own schedule. This route stops DOING WORK once coverage
 * is complete (safe, near-zero-cost no-op forever after) — it does not stop being INVOKED
 * weekly. Removing the vercel.json entry (or leaving it, it's harmless) is a later, separate
 * decision once the notification confirms completion.
 *
 * Weekly, Wednesday 17:30 UTC — clear of every other cron's hour (sync 06:00/06:30, sync-shopify
 * 08:00-08:30, inventory-sweep 08:45/20:45, price-alert 09:00, price-audit 09:30, draft-ttl/
 * stock-check 10:00, csv-precache 04:00/05:30/12:00/18:00, social 13:00, content 14:00 Mon/Wed/
 * Fri, blog 15:00 Tue, gbp-post 16:00 Mon, stock-check 16:00/22:00) and offset from :00 so it
 * never fires in the same instant as the hourly publisher.
 *
 * Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WEEKLY_BATCH_SIZE = 4;
const COMPLETE_NOTIFIED_SETTING = "guide_batch_complete_notified";

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await trackCron(
      "guide-batch",
      async () => {
        const coverage = await getGuideCoverageStatus();

        if (coverage.remainingCount === 0) {
          const alreadyNotified = await getSetting(COMPLETE_NOTIFIED_SETTING);
          if (!alreadyNotified) {
            await createNotification(
              "success",
              "Guides pSEO — couverture complète",
              `Les ${coverage.totalSubcategories} sous-catégories ont toutes été traitées (générées ou signalées bloquées). Le lot hebdomadaire n'a plus rien à générer.`,
            );
            await setSetting(COMPLETE_NOTIFIED_SETTING, "true");
          }
          return { generated: 0, skipped: 0, failed: 0, remainingBefore: 0, complete: true };
        }

        const batch = await generatePilotGuides(WEEKLY_BATCH_SIZE, coverage.excludeCategories);

        if (batch.generated.length > 0) {
          await createNotification(
            "success",
            "Nouveau lot de guides pSEO prêt",
            `${batch.generated.length} nouveau${batch.generated.length > 1 ? "x" : ""} guide${batch.generated.length > 1 ? "s" : ""} généré${batch.generated.length > 1 ? "s" : ""}, en attente de ta relecture dans /guides.`,
          );
        }

        return {
          generated: batch.generated.length,
          skipped: batch.skipped.length,
          failed: batch.failed.length,
          remainingBefore: coverage.remainingCount,
          complete: false,
        };
      },
      (r) => `generated=${r.generated} skipped=${r.skipped} failed=${r.failed} remainingBefore=${r.remainingBefore} complete=${r.complete}`,
    );

    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/guide-batch failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
