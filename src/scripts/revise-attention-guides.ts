/**
 * Quality rescue for pSEO guides flagged "attention" (fact or quality score < 80): re-scores
 * each with the current judges, revises up to 3 times until both passes clear 80, and — with
 * --apply — writes the best version to the Shopify DRAFT (never publishes) + guide_pages.
 * Guides already approved/scheduled for publication are skipped.
 *
 * Usage:
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs src/scripts/revise-attention-guides.ts [--apply] [--ids=1,2,3]
 */
import { getGuidePages } from "@/lib/database";
import { reviseExistingGuideUntilReady } from "@/lib/subcategory-guide-generator";
import { READY_THRESHOLD } from "@/lib/guide-quality-pipeline";

async function main() {
  const apply = process.argv.includes("--apply");
  const idsArg = process.argv.find((a) => a.startsWith("--ids="));
  const onlyIds = idsArg ? new Set(idsArg.slice(6).split(",").map(Number)) : null;

  const guides = await getGuidePages();
  const candidates = guides.filter(
    (g) =>
      g.status === "pending_review" &&
      !g.scheduled_publish_at &&
      (onlyIds ? onlyIds.has(g.id) : (g.fact_check_score ?? 0) < READY_THRESHOLD || (g.quality_score ?? 0) < READY_THRESHOLD),
  );
  console.log(`${apply ? "APPLY" : "DRY-RUN"} — ${candidates.length} guide(s)\n`);

  for (const g of candidates) {
    try {
      const r = await reviseExistingGuideUntilReady(g.id, { apply });
      console.log(
        `RESULT #${r.guideId} ${r.status.toUpperCase()} | stored f=${g.fact_check_score} q=${g.quality_score} | ` +
          `rescored f=${r.before.factCheck} q=${r.before.quality} → f=${r.after.factCheck} q=${r.after.quality} | ` +
          `revisions=${r.attempts} written=${r.written} | ${g.shopify_collection_title} (${g.aosom_category})`,
      );
    } catch (err) {
      console.error(`RESULT #${g.id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error("revise-attention-guides failed:", err);
  process.exitCode = 1;
});
