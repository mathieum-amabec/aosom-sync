/**
 * One-shot runner: generate a batch of subcategory guide pages. Creates real Shopify draft
 * articles (published: false — never live) in the "Guides" blog.
 *
 * Always excludes subcategories already present in guide_pages (any status), so re-running
 * this after the pilot never regenerates a duplicate for an already-covered subcategory.
 *
 * Usage: node-x64 --env-file=.env.local -r tsx/cjs src/scripts/run-guide-pilot.ts [count]
 */
import { generatePilotGuides } from "@/lib/subcategory-guide-generator";
import { getGuidePages } from "@/lib/database";

async function main() {
  const count = Number(process.argv[2]) || 5;
  const already = await getGuidePages();
  const excludeCategories = new Set(already.map((g) => g.aosom_category));
  console.log(`Generating up to ${count} subcategory guides (excluding ${excludeCategories.size} already covered)...\n`);

  const result = await generatePilotGuides(count, excludeCategories);

  console.log(`\n=== GÉNÉRÉS (${result.generated.length}) ===`);
  for (const g of result.generated) {
    console.log(`- ${g.aosomCategory}`);
    console.log(`  titre: ${g.title}`);
    console.log(`  url réelle: https://ameublodirect.ca/blogs/guides/${g.shopifyHandle}`);
    console.log(`  admin: ${g.adminUrl}`);
    console.log(`  pillarGuideMissing: ${g.pillarGuideMissing}`);
  }

  console.log(`\n=== IGNORÉS (${result.skipped.length}) ===`);
  for (const s of result.skipped) {
    console.log(`- ${s.aosomCategory} (${s.shopifyCollectionTitle}): ${s.reason}`);
  }

  console.log(`\n=== ÉCHECS (${result.failed.length}) ===`);
  for (const f of result.failed) {
    console.log(`- ${f.aosomCategory}: ${f.error}`);
  }

  if (result.failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("run-guide-pilot failed:", err);
  process.exitCode = 1;
});
