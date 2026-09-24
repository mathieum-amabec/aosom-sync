/**
 * One-shot backfill: the 5 pilot guides created 2026-09-22 (before this round's quality
 * pipeline + body_html storage existed) are missing both from `guide_pages`. Fetches each
 * article's real current Shopify body, runs the real 3-pass quality pipeline against it, and
 * stores both — so the new /guides review page has real content and real verdicts for them
 * immediately, and this run's measured Claude usage doubles as the real cost figures for the
 * multi-agent pipeline report (not an estimate).
 */
import { getGuidePages, getSubcategoryTrendStats, updateGuidePageVerdictAndBody } from "@/lib/database";
import { shopifyFetch, getShopifyProductTitle } from "@/lib/shopify-client";
import { factCheckGuideCopy, qualityCheckGuideCopy } from "@/lib/guide-quality-pipeline";

async function main() {
  const guides = await getGuidePages();
  // Covers two cases: rows never backfilled at all (no body_html), and rows whose push
  // succeeded but whose quality pipeline crashed (body_html present, fact_check_score null —
  // e.g. the JSON-truncation bug fixed in guide-quality-pipeline.ts's salvage parser).
  const pending = guides.filter((g) => g.status === "pending_review" && (!g.body_html || g.fact_check_score === null));
  console.log(`Backfilling ${pending.length} pilot guide(s)...\n`);

  const allStats = await getSubcategoryTrendStats();

  for (const g of pending) {
    if (!g.shopify_blog_id || !g.shopify_article_id) continue;
    const res = await shopifyFetch(`/blogs/${g.shopify_blog_id}/articles/${g.shopify_article_id}.json?fields=body_html`);
    if (!res.ok) {
      console.log(`- ${g.aosom_category}: could not fetch article body (HTTP ${res.status})`);
      continue;
    }
    const data = (await res.json()) as { article?: { body_html?: string } };
    const bodyHtml = data.article?.body_html || "";

    const stats = allStats.find((s) => s.aosomCategory === g.aosom_category);
    if (!stats) {
      console.log(`- ${g.aosom_category}: no current trend stats match, skipping quality pipeline`);
      continue;
    }
    const titles = await Promise.all(stats.topProducts.map((p) => getShopifyProductTitle(p.shopify_product_id, p.name)));

    // Whole-article text as a single field — the judge prompts concatenate + strip-HTML
    // internally regardless of field boundaries, so this is functionally equivalent to the
    // structured copy object for a retroactive real-content check.
    const copy = { introHtml: bodyHtml, comparisonIntroHtml: "", chooseHtml: "", conclusionHtml: "", faq: [] };

    const [factCheck, quality] = await Promise.all([
      factCheckGuideCopy(stats, titles, copy),
      qualityCheckGuideCopy(copy),
    ]);

    const overallScore = Math.min(factCheck.score, quality.score);
    const overallStatus = overallScore >= 80 ? "ready" : "attention";

    await updateGuidePageVerdictAndBody(g.id, {
      bodyHtml,
      factCheckScore: factCheck.score,
      factCheckIssues: factCheck.reasons,
      qualityScore: quality.score,
      qualityReasons: quality.reasons,
      overallStatus,
    });

    console.log(`- ${g.aosom_category}: fact=${factCheck.score} quality=${quality.score} → ${overallStatus}`);
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exitCode = 1;
});
