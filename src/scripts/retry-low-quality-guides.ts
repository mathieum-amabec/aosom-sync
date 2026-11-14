/**
 * One-shot runner: apply the automatic targeted-retry mechanism to every pending_review guide
 * whose quality_score is below RETRY_QUALITY_THRESHOLD (retroactive — for guides generated
 * before this mechanism existed). Updates the live Shopify draft in place and records both
 * scores. Never publishes anything.
 *
 * Usage: node-x64 --env-file=.env.local tsx src/scripts/retry-low-quality-guides.ts
 */
import { getGuidePages } from "@/lib/database";
import { retryExistingGuideQuality } from "@/lib/subcategory-guide-generator";
import { RETRY_QUALITY_THRESHOLD } from "@/lib/guide-quality-pipeline";

async function main() {
  const guides = await getGuidePages();
  const candidates = guides.filter(
    (g) => g.status === "pending_review" && g.quality_score !== null && g.quality_score < RETRY_QUALITY_THRESHOLD,
  );
  console.log(`Found ${candidates.length} guide(s) below quality_score < ${RETRY_QUALITY_THRESHOLD}\n`);

  for (const g of candidates) {
    console.log(`--- ${g.id} | ${g.shopify_collection_title} (quality=${g.quality_score}) ---`);
    try {
      const result = await retryExistingGuideQuality(g.id);
      console.log(
        `  quality ${result.qualityScoreBefore} → ${result.qualityScoreAfter} | ` +
          `fact ${result.factCheckScoreBefore} → ${result.factCheckScoreAfter} | ` +
          `improved=${result.improved}`,
      );
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error("retry-low-quality-guides failed:", err);
  process.exitCode = 1;
});
