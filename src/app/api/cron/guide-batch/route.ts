import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { createNotification, getGuidePages, getSetting, setSetting } from "@/lib/database";
import {
  generatePilotGuides,
  generateCollectionGuides,
  getGuideCoverageStatus,
} from "@/lib/subcategory-guide-generator";

/**
 * GET /api/cron/guide-batch — weekly pSEO guide batch.
 *
 * Two topic sources, in order:
 *   1. the real 'sub' subcategories (collection_mappings) not yet covered by a guide_pages row;
 *   2. once those are all covered (28/28 since 2026-09-27), the store's fine-grained French
 *      smart collections (guide-collection-topics.ts: ≥ 10 in stock, near-duplicates skipped,
 *      holiday topics first in season). Those guides also go through the multi-pass revision
 *      right away.
 * Every guide is a Shopify DRAFT (published:false, guaranteed by createBlogArticle) — this
 * cron has no code path that can publish anything; publishing is the operator's "Approuver".
 *
 * PACING — deliberately slow (Google's scaled-content-abuse policy targets mass AI pages):
 *   - WEEKLY_BATCH_SIZE = 2, equal to the publish cadence (guide_schedule: Tue + Fri), so
 *     generation never outruns publication;
 *   - REVIEW_BACKLOG_CAP: no new guide while that many generated guides are still waiting for
 *     Mat's review (pending_review and not yet scheduled). Output follows human review.
 *
 * STOP CONDITION: when both sources are exhausted, a one-time "coverage complete" notification
 * fires (guarded by the `guide_batch_complete_notified` setting); later runs are cheap no-ops.
 * A running function can't remove its own vercel.json schedule.
 *
 * Weekly, Wednesday 17:30 UTC — clear of every other cron's hour. Protected by CRON_SECRET.
 */
export const dynamic = "force-dynamic";
// Generation + up to 3 revision passes per collection guide (CLAUDE.MODEL) × 2 guides.
export const maxDuration = 800;

const WEEKLY_BATCH_SIZE = 2;
const REVIEW_BACKLOG_CAP = 6;
const COMPLETE_NOTIFIED_SETTING = "guide_batch_complete_notified";

function plural(n: number, one: string, many: string): string {
  return n > 1 ? many : one;
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await trackCron(
      "guide-batch",
      async () => {
        const guides = await getGuidePages();
        const awaitingReview = guides.filter((g) => g.status === "pending_review" && !g.scheduled_publish_at).length;
        if (awaitingReview >= REVIEW_BACKLOG_CAP) {
          return { generated: 0, skipped: 0, failed: 0, remainingBefore: null as number | null, complete: false, paused: true, awaitingReview, source: null as string | null };
        }

        const coverage = await getGuideCoverageStatus();

        let generated = 0;
        let skipped = 0;
        let failed = 0;
        let remainingBefore: number;
        let source: "subcategories" | "collections";

        if (coverage.remainingCount > 0) {
          source = "subcategories";
          remainingBefore = coverage.remainingCount;
          const batch = await generatePilotGuides(WEEKLY_BATCH_SIZE, coverage.excludeCategories);
          generated = batch.generated.length;
          skipped = batch.skipped.length;
          failed = batch.failed.length;
        } else {
          source = "collections";
          const batch = await generateCollectionGuides(WEEKLY_BATCH_SIZE, coverage.excludeCategories);
          remainingBefore = batch.remainingEligible;
          generated = batch.generated.length;
          failed = batch.failed.length;
        }

        if (generated > 0) {
          await createNotification(
            "success",
            "Nouveau lot de guides pSEO prêt",
            `${generated} ${plural(generated, "nouveau guide généré", "nouveaux guides générés")}, en attente de ta relecture dans /guides.`,
          );
        }

        const complete = source === "collections" && remainingBefore === 0;
        if (complete && !(await getSetting(COMPLETE_NOTIFIED_SETTING))) {
          await createNotification(
            "success",
            "Guides pSEO — couverture complète",
            `Les ${coverage.totalSubcategories} sous-catégories et toutes les collections admissibles ont leur guide. Le lot hebdomadaire n'a plus rien à générer.`,
          );
          await setSetting(COMPLETE_NOTIFIED_SETTING, "true");
        }

        return { generated, skipped, failed, remainingBefore: remainingBefore as number | null, complete, paused: false, awaitingReview, source: source as string | null };
      },
      (r) =>
        r.paused
          ? `paused: ${r.awaitingReview} guides awaiting review (cap ${REVIEW_BACKLOG_CAP})`
          : `source=${r.source} generated=${r.generated} skipped=${r.skipped} failed=${r.failed} remainingBefore=${r.remainingBefore} complete=${r.complete}`,
    );

    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/guide-batch failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
