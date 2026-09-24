import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { env } from "@/lib/config";
import { generateWeeklyGbpPost, AUTO_PUBLISH_MIN_SCORE } from "@/lib/gbp-post-generator";
import { publishPendingGbpPost } from "@/lib/gbp-publish";

/**
 * GET /api/cron/gbp-post — weekly Google Business Profile post generation.
 *
 * Always generates + stores a `gbp_posts` row (pending_review / rejected / failed). Only
 * attempts a REAL publish when GBP_AUTO_PUBLISH=true AND the judge score clears
 * AUTO_PUBLISH_MIN_SCORE — and even then, publishPendingGbpPost refuses the very first-ever
 * post without an explicit human confirmation (see gbp-publish.ts), so flipping the env flag
 * alone can never skip Mat seeing the first one. Weekly, Monday 16:00 UTC — clear of the
 * daily 13:00 social cron, the Mon/Wed/Fri 14:00 content cron, and the Tuesday 15:00 blog cron.
 *
 * Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await trackCron(
      "gbp-post",
      async () => {
        const generated = await generateWeeklyGbpPost();
        if (!generated) {
          return { generated: false as const };
        }

        let published = false;
        let publishSkippedReason: string | undefined;
        if (env.gbpAutoPublish && generated.judgeScore >= AUTO_PUBLISH_MIN_SCORE) {
          const outcome = await publishPendingGbpPost(generated.postId);
          if (outcome.ok) {
            published = true;
          } else {
            publishSkippedReason = outcome.reason;
          }
        }

        return {
          generated: true as const,
          postId: generated.postId,
          sku: generated.sku,
          judgeScore: generated.judgeScore,
          published,
          publishSkippedReason,
        };
      },
      (r) =>
        r.generated
          ? `sku=${r.sku} score=${r.judgeScore} published=${r.published}${r.publishSkippedReason ? ` (skip: ${r.publishSkippedReason})` : ""}`
          : "no candidate this week",
    );

    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/gbp-post failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
