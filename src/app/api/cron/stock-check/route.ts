import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { getStockBaseline, updateStockBaselineQty } from "@/lib/database";
import { getShopifyStockState, updateShopifyProduct } from "@/lib/shopify-client";
import { applyStockTags, STOCK_TAG_AUTODRAFTED } from "@/lib/diff-engine";
import { planStockActions, assertFeedComplete, type PlannedAction } from "@/lib/stock-reconcile";
import { notifyBackInStockWaitlist } from "@/jobs/job1-sync";

// Cap Shopify writes per run so a mass-rupture day can't blow the function budget mid-loop.
// Actions are processed worst-first (OOS/draft before restock) so the cap never starves rupture
// detection; the overflow is reported as `deferred` and drained by the next (convergent) run.
const WRITE_CAP = 150;
const ACTION_RANK: Record<string, number> = { oos: 0, draft: 1, restock: 2 };



const hasAutoDraft = (tags: string[]) => tags.some((t) => t.toLowerCase() === STOCK_TAG_AUTODRAFTED);
const withoutAutoDraft = (tags: string[]) => tags.filter((t) => t.toLowerCase() !== STOCK_TAG_AUTODRAFTED);

interface StockCheckResult {
  dryRun: boolean;
  scanned: number;
  wentOOS: number;
  restocked: number;
  drafted: number;
  skipped: number;
  deferred: number;
  errors: number;
  notified: number;
  planned?: PlannedAction[];
}

/**
 * Lightweight intraday stock reconciliation (10:00 / 16:00 / 22:00 UTC). Re-fetches ONLY the
 * Aosom CSV, diffs qty (not prices/images), and flips the customer-visible stock state:
 *   - went out of stock  -> tag `out-of-stock` (stays active; badge + waitlist still work)
 *   - back in stock      -> tag `back-in-stock`; reactivate iff WE auto-drafted it; notify waitlist
 *   - sold out & gone from the feed >7d -> draft + `auto-drafted` marker (discontinued)
 * No date checkpoint: convergent and freely re-runnable. `?dryRun=1` plans without writing.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  try {
    const result = await trackCron(
      dryRun ? "stock-check-dryrun" : "stock-check",
      () => runStockCheck(dryRun),
      (r) => `${r.scanned} scanned, ${r.wentOOS} OOS, ${r.restocked} restock, ${r.drafted} draft, ${r.notified} notified${r.deferred ? `, ${r.deferred} deferred` : ""}${r.errors ? `, ${r.errors} errors` : ""}${r.dryRun ? " [dry-run]" : ""}`,
    );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error("[CRON] stock-check failed:", err);
    return NextResponse.json({ success: false, error: "stock-check failed" }, { status: 500 });
  }
}

async function runStockCheck(dryRun: boolean): Promise<StockCheckResult> {
  const csv = await fetchAosomCatalog();
  const csvQtyBySku = new Map<string, number>();
  for (const p of csv) csvQtyBySku.set(p.sku, p.qty);

  const baseline = await getStockBaseline();
  // Feed-completeness guard — bail (recorded as an error in cron_runs) before ANY write if the
  // fetched feed is implausibly thin, so a truncated CSV can't mass-flip the catalog.
  assertFeedComplete(csvQtyBySku, baseline);

  const plan = planStockActions({ csvQtyBySku, baseline, nowEpoch: Math.floor(Date.now() / 1000) });

  const res: StockCheckResult = {
    dryRun, scanned: plan.counts.products,
    wentOOS: 0, restocked: 0, drafted: 0, skipped: 0, deferred: 0, errors: 0, notified: 0,
    ...(dryRun ? { planned: plan.actions } : {}),
  };

  // Worst-first: OOS/draft (availability lost) before restock, so the write cap never starves
  // rupture detection. qtyBySku lets us persist just the flipped product's baseline after each write.
  const ordered = [...plan.actions].sort((a, b) => ACTION_RANK[a.action] - ACTION_RANK[b.action]);
  const qtyBySku = new Map(plan.qtyUpdates.map((u) => [u.sku, u.qty]));
  let writes = 0;

  // Sequential — one product at a time keeps us well under Shopify's ~2 req/s limit
  // (shopifyFetch already backs off on 429/5xx). A single product's failure is logged and
  // skipped so one bad product never aborts the whole run.
  for (const a of ordered) {
    if (writes >= WRITE_CAP) { res.deferred++; continue; } // over budget — next run drains it
    try {
      const state = await getShopifyStockState(a.shopifyProductId);
      if (!state) { res.skipped++; continue; } // 404 — product deleted from Shopify (no write, no cap)

      if (a.action === "oos") {
        const tags = applyStockTags(state.tags, false);
        if (!dryRun) await updateShopifyProduct(a.shopifyProductId, { tags });
        res.wentOOS++;
      } else if (a.action === "restock") {
        let tags = applyStockTags(state.tags, true);
        const reactivate = state.status === "draft" && hasAutoDraft(state.tags);
        if (reactivate) tags = withoutAutoDraft(tags); // clear our marker as we bring it back
        if (!dryRun) {
          await updateShopifyProduct(a.shopifyProductId, reactivate ? { status: "active", tags } : { tags });
          // Notify BEFORE persisting the baseline below, so a crash re-detects + re-notifies
          // (at-least-once) rather than dropping the waitlist alert.
          if (a.restockSkus.length > 0) await notifyBackInStockWaitlist(a.restockSkus);
        }
        res.notified += a.restockSkus.length;
        res.restocked++;
      } else { // draft
        if (state.status !== "active") { res.skipped++; continue; } // already draft/archived (no write, no cap)
        const tags = [...applyStockTags(state.tags, false), STOCK_TAG_AUTODRAFTED];
        if (!dryRun) await updateShopifyProduct(a.shopifyProductId, { status: "draft", tags });
        res.drafted++;
      }

      // Persist this product's new baseline qty NOW (not batched at the end) so a budget-killed
      // run keeps its progress and the next run resumes where it stopped. (draft = absent from
      // the feed → no qtyBySku entries → nothing to write.)
      if (!dryRun) {
        const updates = a.skus.flatMap((s) => (qtyBySku.has(s) ? [{ sku: s, qty: qtyBySku.get(s)! }] : []));
        if (updates.length > 0) await updateStockBaselineQty(updates);
      }
      writes++; // counts toward the per-run cap (real or, in dry-run, simulated)
    } catch (err) {
      res.errors++;
      console.error(`[stock-check] ${a.action} failed for product ${a.shopifyProductId}:`, err);
    }
  }

  return res;
}

export const maxDuration = 300;
