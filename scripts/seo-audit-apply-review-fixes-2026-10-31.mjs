#!/usr/bin/env node
/**
 * Applies the meta-description rewrites produced by the 3 review agents (fixes-1..3.json in
 * .context/seo-audit/review/) after the 2026-10-31 SEO run: weak FR text, FR/EN fact mismatches,
 * bad EN. FR goes through productUpdate (seo.title re-sent so it is never wiped); EN through
 * translationsRegister against the CURRENT FR digest. Backup of every before-value is written first.
 *   node-x64 --env-file=.env.local scripts/seo-audit-apply-review-fixes-2026-10-31.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";
loadEnv();
const APPLY = process.argv.includes("--apply");
const DIR = ".context/seo-audit/review";
const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;
const fixes = [1, 2, 3].flatMap((k) => JSON.parse(fs.readFileSync(`${DIR}/fixes-${k}.json`, "utf8")));
// The independent QA agent's corrections (qa-rejects.json) win over the writers' text.
for (const q of JSON.parse(fs.readFileSync(`${DIR}/qa-rejects.json`, "utf8"))) {
  const f = fixes.find((x) => x.id === q.id);
  if (!f) throw new Error(`QA reject for unknown id ${q.id}`);
  f[q.field] = q.suggested;
}
const check = (v, end) => !v || (v.length >= 100 && v.length <= 160 && v.endsWith(end) && !BRAND_RE.test(v) && !/[$%…]/.test(v));
const bad = fixes.filter((f) => !check(f.meta_fr, " Livraison gratuite partout au Canada.") || !check(f.meta_en, " Free shipping across Canada."));
if (bad.length) { console.log("INVALID:", JSON.stringify(bad, null, 1)); process.exit(1); }
console.log(`${fixes.length} products · FR ${fixes.filter((f) => f.meta_fr).length} · EN ${fixes.filter((f) => f.meta_en).length}`);
const backupPath = `${DIR}/backup-before-review-fixes.json`;
const backup = fs.existsSync(backupPath) ? JSON.parse(fs.readFileSync(backupPath, "utf8")) : {};
let errors = 0;
for (const f of fixes) {
  const p = (await gql(`query($id:ID!){product(id:$id){seo{title description} translations(locale:"en"){key value}}}`, { id: f.id })).data.product;
  backup[f.id] ??= { handle: f.handle, seo: p.seo, en: p.translations.find((t) => t.key === "meta_description")?.value ?? null };
  if (!APPLY) continue;
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 1));
  if (f.meta_fr) {
    const u = await gql(`mutation($p:ProductInput!){productUpdate(input:$p){product{seo{title}} userErrors{field message}}}`, { p: { id: f.id, seo: { title: p.seo.title, description: f.meta_fr } } });
    const e = u.data.productUpdate.userErrors;
    if (e.length || u.data.productUpdate.product.seo.title !== p.seo.title) { console.log("✘ FR", f.handle, JSON.stringify(e)); errors++; continue; }
  }
  // Re-register EN against the new FR digest: the new EN text, else the existing EN (or Shopify marks it outdated).
  const en = f.meta_en ?? backup[f.id].en;
  if (en) {
    const dig = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: f.id })).data.translatableResource.translatableContent.find((c) => c.key === "meta_description")?.digest;
    const r = await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: f.id, t: [{ key: "meta_description", locale: "en", value: en, translatableContentDigest: dig }] });
    if (r.data.translationsRegister.userErrors.length) { console.log("✘ EN", f.handle, JSON.stringify(r.data.translationsRegister.userErrors)); errors++; }
  }
  await sleep(400);
}
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 1));
console.log(`${APPLY ? "APPLIED" : "DRY-RUN"} — ${errors} error(s) · backup ${backupPath}`);
