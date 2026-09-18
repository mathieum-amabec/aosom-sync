#!/usr/bin/env tsx
/**
 * scripts/regenerate-scope-mismatched-drafts.mts
 *
 * Regenerates the 40 facebook_drafts (status draft/approved) generated BEFORE PR #480
 * (fix/social-text-product-mismatch, commit 71e587b) whose product falls under a scope
 * SCOPE_RULES used to misclassify — Home Furnishings > Holiday & Seasonal / Home Décor /
 * Appliances / Bathroom Furniture — and therefore got mobilier_indoor hooks + patio
 * hashtags (e.g. draft #938, a Halloween inflatable cat, opening with "This bedroom
 * collection sells out fast..."). The code fix only changes future generation; this
 * script backfills the 40 that already exist. See the overnight-recovery session plan.
 *
 * Two of these (#937, #938) have PENDING publication_queue rows (both due 2026-09-18,
 * #938 at 14:00 UTC) — their queue payload is rebuilt too via the same draftToQueueItems
 * the approve/schedule routes use, so what actually publishes matches the new text.
 *
 * Modes:
 *   --dry-run   Regenerate FR/EN text for each draft, print before/after. Writes NOTHING.
 *   --apply     Same, then write facebook_drafts.post_text/post_text_en and rebuild any
 *               pending publication_queue.payload for that draft.
 *   --only <id,id,...>   Restrict to specific draft ids (e.g. the 2 urgent ones first).
 *
 * Run: node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/regenerate-scope-mismatched-drafts.mts --dry-run
 */
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const APPLY = argv.includes("--apply");
const ONLY = (() => {
  const i = argv.indexOf("--only");
  if (i < 0 || !argv[i + 1]) return null;
  return new Set(argv[i + 1].split(",").map((s) => Number(s.trim())));
})();

// The 40 drafts confirmed via a live Turso query against prod (2026-09-18) to sit in
// draft/approved status and join to a product whose product_type falls under a scope
// SCOPE_RULES misclassified before #480. Frozen list, not re-queried at run time, so a
// draft that gets approved/published mid-run isn't silently skipped or double-handled.
const TARGET_DRAFT_IDS = [
  540, 580, 717, 764, 776, 777, 778, 784, 847, 854, 858, 863, 873, 875, 876, 877, 878, 879,
  880, 889, 890, 891, 892, 893, 894, 898, 899, 904, 912, 913, 914, 915, 916, 917, 918, 922,
  923, 924, 937, 938,
];

const LOG_FILE = ".tmp-socialfix/regenerate-applied.jsonl";

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function loadLib() {
  const [db, job4, selector, publisher, config] = await Promise.all([
    import("@/lib/database"),
    import("@/jobs/job4-social"),
    import("@/lib/hook-selector"),
    import("@/lib/social-publisher"),
    import("@/lib/config"),
  ]);
  return { db, job4, selector, publisher, config };
}

// generateBilingual's triggerType param ("new_product" | "price_drop" | "highlight")
// differs from the DB's facebook_drafts.trigger_type ("new_product" | "price_drop" |
// "stock_highlight") — see runStockHighlight in job4-social.ts, which passes "highlight".
function toGenerateTriggerType(dbTriggerType: string): "new_product" | "price_drop" | "highlight" {
  if (dbTriggerType === "new_product") return "new_product";
  if (dbTriggerType === "price_drop") return "price_drop";
  return "highlight";
}

async function main() {
  if (!DRY_RUN && !APPLY) {
    console.log("usage: regenerate-scope-mismatched-drafts.mts --dry-run | --apply [--only id,id,...]");
    process.exit(1);
  }

  const { db, job4, publisher, config } = await loadLib();
  const base = ONLY ? TARGET_DRAFT_IDS.filter((id) => ONLY.has(id)) : TARGET_DRAFT_IDS;
  // Urgent-first: #938 and #937 have pending publication_queue rows due today
  // (2026-09-18, #938 at 14:00 UTC) — process them before the rest so an early
  // abort still lands the ones with a real publish deadline.
  const URGENT = [938, 937];
  const ids = [...URGENT.filter((id) => base.includes(id)), ...base.filter((id) => !URGENT.includes(id))];
  const settings = await db.getAllSettings();

  console.log(`target: ${ids.length} drafts (${DRY_RUN ? "dry-run" : "APPLY"})`);
  if (APPLY) ensureDir(LOG_FILE);

  let ok = 0;
  let failed = 0;
  let queueRowsUpdated = 0;

  for (const id of ids) {
    const draft = await db.getFacebookDraft(id);
    if (!draft) {
      console.log(`#${id}: SKIP — draft not found`);
      failed++;
      continue;
    }
    if (draft.status !== "draft" && draft.status !== "approved") {
      console.log(`#${id}: SKIP — status is now "${draft.status}" (published/rejected since the audit)`);
      continue;
    }
    const product = await db.getProduct(draft.sku);
    if (!product) {
      console.log(`#${id}: SKIP — product ${draft.sku} not found`);
      failed++;
      continue;
    }

    const productName = product.name || draft.sku;
    const generateTriggerType = toGenerateTriggerType(draft.triggerType);
    const vars: Record<string, string> =
      generateTriggerType === "price_drop"
        ? {
            product_name: productName,
            price: String(draft.newPrice ?? product.price),
            old_price: String(draft.oldPrice ?? product.price),
            new_price: String(draft.newPrice ?? product.price),
            store_name: config.env.storeName,
          }
        : generateTriggerType === "new_product"
          ? { product_name: productName, price: String(product.price), store_name: config.env.storeName }
          : {
              product_name: productName,
              price: String(product.price),
              qty: String(product.qty),
              store_name: config.env.storeName,
            };

    try {
      const { fr, en } = await job4.generateBilingual(settings, generateTriggerType, vars, product.product_type);

      console.log(`\n#${id} [${draft.sku}] ${product.product_type}`);
      console.log(`  FR before: ${draft.postText.slice(0, 90).replace(/\n/g, " ")}`);
      console.log(`  FR after : ${fr.slice(0, 90).replace(/\n/g, " ")}`);
      console.log(`  EN before: ${(draft.postTextEn ?? "").slice(0, 90).replace(/\n/g, " ")}`);
      console.log(`  EN after : ${en.slice(0, 90).replace(/\n/g, " ")}`);

      if (APPLY) {
        await db.updateFacebookDraft(id, { post_text: fr, post_text_en: en });

        const updatedDraft = { ...draft, postText: fr, postTextEn: en };
        const items = publisher.draftToQueueItems(updatedDraft, config.activeChannels());
        const byContent = await db.getQueueRowsForContent("social", [String(id)]);
        const rows = (byContent.get(String(id)) ?? []).filter((r) => r.status === "pending");

        const client = await db.ensureSchema();
        for (const row of rows) {
          const match = items.find((it) => it.platform === row.platform);
          if (!match) continue;
          await client.execute({
            sql: `UPDATE publication_queue SET payload = ? WHERE id = ? AND status = 'pending'`,
            args: [JSON.stringify(match.payload), row.id],
          });
          queueRowsUpdated++;
          console.log(`  -> queue row ${row.id} (${row.platform}) payload rebuilt`);
        }

        appendFileSync(
          LOG_FILE,
          JSON.stringify({ ts: new Date().toISOString(), draftId: id, sku: draft.sku, fr, en }) + "\n",
        );
      }
      ok++;
    } catch (err) {
      console.error(`#${id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\ndone: ${ok} regenerated, ${failed} failed, ${queueRowsUpdated} queue rows rebuilt`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
