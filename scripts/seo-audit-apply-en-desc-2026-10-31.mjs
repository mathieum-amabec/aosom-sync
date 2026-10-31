#!/usr/bin/env node
/**
 * Registers the EN meta descriptions written by an agent for the 66 active products that had none
 * (review/en-desc-fixes.json), with the QA agent's corrections (review/en-desc-qa.json) taking
 * precedence. Registered against the current FR meta_description digest. Dry-run by default.
 *   node-x64 --env-file=.env.local scripts/seo-audit-apply-en-desc-2026-10-31.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";
loadEnv();
const APPLY = process.argv.includes("--apply");
const DIR = ".context/seo-audit/review";
const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;
const fixes = JSON.parse(fs.readFileSync(`${DIR}/en-desc-fixes.json`, "utf8"));
for (const q of JSON.parse(fs.readFileSync(`${DIR}/en-desc-qa.json`, "utf8"))) {
  const f = fixes.find((x) => x.id === q.id);
  if (!f) throw new Error(`QA item for unknown id ${q.id}`);
  f.meta_en = q.suggested;
}
const bad = fixes.filter((f) => f.meta_en.length < 100 || f.meta_en.length > 160 || !f.meta_en.endsWith(" Free shipping across Canada.") || BRAND_RE.test(f.meta_en) || /[$%…]/.test(f.meta_en));
if (bad.length) { console.log("INVALID", JSON.stringify(bad, null, 1)); process.exit(1); }
console.log(`${fixes.length} EN meta descriptions`);
let errors = 0, skipped = 0;
for (const f of fixes) {
  const tr = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest} translations(locale:"en"){key value}}}`, { id: f.id })).data.translatableResource;
  if (tr.translations.some((t) => t.key === "meta_description" && t.value)) { skipped++; continue; } // filled meanwhile — never overwrite
  const dig = tr.translatableContent.find((c) => c.key === "meta_description")?.digest;
  if (!dig) { console.log("✘ no FR meta_description", f.handle); errors++; continue; }
  if (!APPLY) continue;
  const r = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: f.id, t: [{ key: "meta_description", locale: "en", value: f.meta_en, translatableContentDigest: dig }] })).data.translationsRegister;
  if (r.userErrors.length) { console.log("✘", f.handle, JSON.stringify(r.userErrors)); errors++; }
  await sleep(300);
}
console.log(`${APPLY ? "APPLIED" : "DRY-RUN"} — ${errors} error(s), ${skipped} already filled`);
