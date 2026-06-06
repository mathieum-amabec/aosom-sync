// READ-ONLY diagnostic for facebook_drafts. No DELETE/UPDATE — dry-run only.
// Maps the task's SQL to the real schema:
//   - post type lives in `trigger_type` (new_product|stock_highlight|content_template),
//     NOT `content_type` (which is 'product'|informative|... and unused for this).
//   - there is no hook_used/hook_fr/hook_en; the hook is `hook_id` → content_hooks(text,language).
//   - created_at is a UNIX epoch INTEGER, so date math uses strftime('%s', ...).
import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const line = "=".repeat(70);

// 0) Confirm created_at is epoch int + show a human-readable sample.
const sample = await q(
  `SELECT id, created_at, datetime(created_at,'unixepoch') AS as_date, typeof(created_at) AS t
   FROM facebook_drafts ORDER BY created_at DESC LIMIT 1`,
);
console.log(line);
console.log("created_at sanity:", JSON.stringify(sample[0] ?? "(no rows)"));

// ÉTAPE 4 — distribution by trigger_type + status (draft only, per task).
console.log("\n" + line + "\nÉTAPE 4 — DISTRIBUTION (status='draft')\n" + line);
const dist = await q(
  `SELECT trigger_type, status, COUNT(*) AS n,
          datetime(MIN(created_at),'unixepoch') AS oldest,
          datetime(MAX(created_at),'unixepoch') AS newest
   FROM facebook_drafts
   WHERE status = 'draft'
   GROUP BY trigger_type, status
   ORDER BY trigger_type`,
);
for (const r of dist) {
  console.log(`  ${String(r.trigger_type).padEnd(16)} ${String(r.status).padEnd(8)} n=${String(r.n).padStart(5)}  ${r.oldest} → ${r.newest}`);
}
// Also the full picture across all statuses, for context.
console.log("\n  -- all statuses (context) --");
const distAll = await q(
  `SELECT trigger_type, status, COUNT(*) AS n FROM facebook_drafts
   GROUP BY trigger_type, status ORDER BY trigger_type, status`,
);
for (const r of distAll) console.log(`  ${String(r.trigger_type).padEnd(16)} ${String(r.status).padEnd(10)} n=${r.n}`);

// content_type column distribution (to prove it's NOT where 'content_template' lives).
console.log("\n  -- content_type column values (proof it's a different axis) --");
for (const r of await q(`SELECT content_type, COUNT(*) n FROM facebook_drafts GROUP BY content_type`)) {
  console.log(`  content_type=${JSON.stringify(r.content_type)} n=${r.n}`);
}

// ÉTAPE 5 — DRY-RUN purge counts. SELECT COUNT only. NOTHING is deleted.
console.log("\n" + line + "\nÉTAPE 5 — DRY-RUN PURGE (counts only, NO deletion)\n" + line);
const E30 = `cast(strftime('%s','now','-30 days') as integer)`;
const E60 = `cast(strftime('%s','now','-60 days') as integer)`;

const ruleA = (await q(
  `SELECT COUNT(*) n FROM facebook_drafts
   WHERE status='draft' AND trigger_type IN ('new_product','stock_highlight') AND created_at < ${E30}`,
))[0].n;
const ruleB = (await q(
  `SELECT COUNT(*) n FROM facebook_drafts
   WHERE status='draft' AND trigger_type='content_template' AND created_at < ${E60}`,
))[0].n;
// Rule (c) two ways — see WARNING below.
const ruleCall = (await q(
  `SELECT COUNT(*) n FROM facebook_drafts WHERE status='draft' AND hook_id IS NULL`,
))[0].n;
const ruleCcontent = (await q(
  `SELECT COUNT(*) n FROM facebook_drafts WHERE status='draft' AND trigger_type='content_template' AND hook_id IS NULL`,
))[0].n;
// hook_id NULL broken down by trigger_type (to show product posts legitimately have no hook).
const cByTrigger = await q(
  `SELECT trigger_type, COUNT(*) n FROM facebook_drafts WHERE status='draft' AND hook_id IS NULL GROUP BY trigger_type`,
);

// Combined DISTINCT rows that match (a) OR (b) OR (c-all) — the real "would be deleted" set.
const combinedAll = (await q(
  `SELECT COUNT(*) n FROM facebook_drafts WHERE status='draft' AND (
      (trigger_type IN ('new_product','stock_highlight') AND created_at < ${E30})
   OR (trigger_type='content_template' AND created_at < ${E60})
   OR (hook_id IS NULL)
   )`,
))[0].n;
// Conservative variant: rule (c) limited to content_template (don't purge hookless product posts).
const combinedSafe = (await q(
  `SELECT COUNT(*) n FROM facebook_drafts WHERE status='draft' AND (
      (trigger_type IN ('new_product','stock_highlight') AND created_at < ${E30})
   OR (trigger_type='content_template' AND created_at < ${E60})
   OR (trigger_type='content_template' AND hook_id IS NULL)
   )`,
))[0].n;
const totalDraft = (await q(`SELECT COUNT(*) n FROM facebook_drafts WHERE status='draft'`))[0].n;

console.log(`  Rule (a) product (new_product+stock_highlight) > 30d : ${ruleA}`);
console.log(`  Rule (b) content_template > 60d                     : ${ruleB}`);
console.log(`  Rule (c) hook_id IS NULL — ALL triggers             : ${ruleCall}   ⚠ see warning`);
console.log(`  Rule (c) hook_id IS NULL — content_template only    : ${ruleCcontent}`);
console.log("    hook_id IS NULL breakdown by trigger_type:");
for (const r of cByTrigger) console.log(`      ${String(r.trigger_type).padEnd(16)} ${r.n}`);
console.log(`\n  COMBINED distinct (a OR b OR c-ALL)                  : ${combinedAll} of ${totalDraft} draft rows`);
console.log(`  COMBINED distinct (a OR b OR c-content-only) [safer] : ${combinedSafe} of ${totalDraft} draft rows`);
console.log(`\n  ⚠ WARNING on rule (c): product drafts (new_product/stock_highlight) are NOT`);
console.log(`    hook-seeded, so hook_id IS NULL is NORMAL for them — applying (c) to ALL`);
console.log(`    triggers would purge legitimate product drafts. The 'content_template only'`);
console.log(`    variant targets the truly-incomplete editorial drafts. Recommend the safer set.`);

// ÉTAPE 6 — report recent content_template drafts (read-only).
console.log("\n" + line + "\nÉTAPE 6 — RECENT content_template DRAFTS (last 30d, max 20)\n" + line);
const recent = await q(
  `SELECT fd.id,
          fd.language,
          h.text AS hook_text,
          h.language AS hook_lang,
          substr(fd.post_text, 1, 90) AS fr_caption,
          datetime(fd.created_at,'unixepoch') AS created,
          CASE WHEN fd.scheduled_at IS NULL THEN '-' ELSE datetime(fd.scheduled_at,'unixepoch') END AS scheduled
   FROM facebook_drafts fd
   LEFT JOIN content_hooks h ON h.id = fd.hook_id
   WHERE fd.trigger_type = 'content_template'
     AND fd.status = 'draft'
     AND fd.created_at > ${E30}
   ORDER BY fd.created_at DESC
   LIMIT 20`,
);
if (recent.length === 0) {
  console.log("  (none in the last 30 days)");
} else {
  for (const r of recent) {
    console.log(`\n  #${r.id}  [${r.created}]  sched=${r.scheduled}`);
    console.log(`     hook(${r.hook_lang ?? "—"}): ${r.hook_text ?? "(no hook_id)"}`);
    console.log(`     FR: ${r.fr_caption ?? ""}${(r.fr_caption || "").length === 90 ? "…" : ""}`);
  }
}
console.log("\n" + line + "\nDONE — read-only. No rows were modified or deleted.\n" + line);
