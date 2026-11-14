/**
 * Verification-only (no LLM calls, no writes): confirms the 9 corrected collection_mappings
 * are now real, live, product-bearing candidates for selectPilotSubcategories — i.e. the
 * mapping fix actually unblocks generation, not just cosmetic.
 *
 * Usage: node-x64 --env-file=.env.local tsx src/scripts/verify-9-mapping-fix.ts
 */
import { getGuideCoverageStatus, selectPilotSubcategories } from "@/lib/subcategory-guide-generator";

const NINE = new Set([
  "Home Furnishings > Bathroom Furniture",
  "Home Furnishings > Home Décor",
  "Patio & Garden > Wedding & Events Tents",
  "Patio & Garden > Lawn & Garden > Raised Garden Beds",
  "Sports & Recreation > Exercise Equipment",
  "Patio & Garden > Patio Furniture",
  "Sports & Recreation > Bikes & Scooters",
  "Patio & Garden > Patio Swings & Hammocks",
  "Patio & Garden > Sun Loungers",
]);

async function main() {
  const coverage = await getGuideCoverageStatus();
  console.log(
    `coverage: total=${coverage.totalSubcategories} covered=${coverage.coveredCount} remaining=${coverage.remainingCount}`,
  );

  const { candidates, skipped } = await selectPilotSubcategories(coverage.remainingCount, coverage.excludeCategories);

  console.log(`\n--- candidates that ARE eligible (${candidates.length}) ---`);
  for (const c of candidates) {
    const mark = NINE.has(c.stats.aosomCategory) ? " <== one of the 9" : "";
    console.log(`${c.stats.aosomCategory} | ${c.stats.topProducts.length} produits | handle=${c.collectionHandle}${mark}`);
  }

  console.log(`\n--- still skipped (${skipped.length}) ---`);
  for (const s of skipped) {
    const mark = NINE.has(s.aosomCategory) ? " <== one of the 9" : "";
    console.log(`${s.aosomCategory}: ${s.reason}${mark}`);
  }

  console.log("\n--- verdict on the 9 ---");
  for (const cat of NINE) {
    const isCandidate = candidates.some((c) => c.stats.aosomCategory === cat);
    const skip = skipped.find((s) => s.aosomCategory === cat);
    console.log(`${cat}: ${isCandidate ? "UNBLOCKED, eligible" : skip ? `STILL SKIPPED — ${skip.reason}` : "not found at all"}`);
  }
}

main().catch((err) => {
  console.error("verify-9-mapping-fix failed:", err);
  process.exitCode = 1;
});
