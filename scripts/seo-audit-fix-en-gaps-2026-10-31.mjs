#!/usr/bin/env node
/**
 * EN gaps found by the final 2026-10-31 verification scan of the active catalogue:
 *  - EN meta_title missing or outdated (some cut mid-phrase on 2026-10-16) → rebuilt from the EN
 *    title at a word boundary + " | Furnish Direct";
 *  - EN meta_description missing → NOT written here (auto-built text read badly): the products are
 *    exported to .context/seo-audit/review/en-desc-missing.json for a writer agent;
 *  - EN title outdated → same value re-registered against the current digest.
 * Every value is registered against the CURRENT FR digest. Dry-run by default.
 *   node-x64 --env-file=.env.local scripts/seo-audit-fix-en-gaps-2026-10-31.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";
loadEnv();
const APPLY = process.argv.includes("--apply");
const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;
const CTA_RE = /^(shop|order|buy|get yours|free shipping|add to cart)/i;
const SUFFIX = " | Furnish Direct";
const DANGLING = /\s+(with|and|for|of|in|to|the|a|an|&|—|-|,|x)$/i;
const metaTitle = (t) => {
  let s = t.replace(/\s+/g, " ").trim();
  const max = 60 - SUFFIX.length;
  if (s.length > max) {
    // Prefer cutting at the " — colour" / ", detail" separator, else at a word boundary.
    const sep = s.lastIndexOf(" — ", max);
    s = sep > 20 ? s.slice(0, sep) : s.slice(0, s.lastIndexOf(" ", max + 1));
  }
  while (DANGLING.test(s)) s = s.replace(DANGLING, "");
  return s.replace(/[,—-]\s*$/, "").trim() + SUFFIX;
};

const plan = [];
const missingDesc = [];
let cursor = null;
do {
  const r = await gql(`query($c:String){products(first:50,after:$c,query:"status:active"){pageInfo{hasNextPage endCursor}
    nodes{id handle tEn:metafield(namespace:"custom",key:"title_en"){value} bEn:metafield(namespace:"custom",key:"body_html_en"){value}
    translatableResource:translations(locale:"en"){key value outdated}}}}`, { c: cursor });
  for (const p of r.data.products.nodes) {
    const tr = Object.fromEntries(p.translatableResource.map((t) => [t.key, t]));
    const enTitle = tr.title?.value || p.tEn?.value || "";
    const t = [];
    if (tr.title?.outdated) t.push({ key: "title", value: tr.title.value });
    if (enTitle && (!tr.meta_title || tr.meta_title.outdated)) t.push({ key: "meta_title", value: metaTitle(enTitle), old: tr.meta_title?.value });
    if (!tr.meta_description?.value) missingDesc.push({ id: p.id, handle: p.handle, title_en: enTitle, body_en: (p.bEn?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500) });
    for (const x of t) if (BRAND_RE.test(x.value)) throw new Error(`supplier name in ${p.handle}: ${x.value}`);
    if (t.length) plan.push({ id: p.id, handle: p.handle, t });
  }
  cursor = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  await sleep(300);
} while (cursor);
fs.writeFileSync(".context/seo-audit/review/en-desc-missing.json", JSON.stringify(missingDesc, null, 1));
fs.writeFileSync(".context/seo-audit/plan-en-gaps.json", JSON.stringify(plan, null, 1));
const count = (k) => plan.filter((p) => p.t.some((x) => x.key === k)).length;
console.log(`EN meta_description missing (exported): ${missingDesc.length}`);
console.log(`products: ${plan.length} · title ${count("title")} · meta_title ${count("meta_title")} · meta_description ${count("meta_description")}`);
for (const p of plan.slice(0, 400).filter((_, i) => i % 40 === 0)) for (const x of p.t) console.log(`  ${p.handle} [${x.key}] ${x.old ? x.old + "  →  " : ""}${x.value}`);
for (const p of plan.filter((p) => p.t.some((x) => x.key === "meta_description")).slice(0, 6)) console.log(`  ${p.handle} [meta_description] ${p.t.find((x) => x.key === "meta_description").value}`);
if (!APPLY) { console.log("DRY-RUN"); process.exit(0); }

let errors = 0;
for (const p of plan) {
  const dig = Object.fromEntries((await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: p.id })).data.translatableResource.translatableContent.map((c) => [c.key, c.digest]));
  const t = p.t.filter((x) => dig[x.key]).map((x) => ({ key: x.key, locale: "en", value: x.value, translatableContentDigest: dig[x.key] }));
  if (!t.length) continue;
  const r = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: p.id, t })).data.translationsRegister;
  if (r.userErrors.length) { console.log("✘", p.handle, JSON.stringify(r.userErrors)); errors++; }
  await sleep(250);
}
console.log(`APPLIED — ${errors} error(s)`);
