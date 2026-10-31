#!/usr/bin/env node
/**
 * Product Q&A pilot (docs/PLAN-IA-VISIBILITE-2026-11.md, chantier 1): writes the agent-written,
 * agent-verified Q&A of the 100 top products into JSON metafields custom.faq_fr / custom.faq_en.
 * Rendered by snippets/agentic-faq.liquid (visible block + FAQPage). Nothing shows until the theme
 * with that snippet is live, so writing them first is harmless.
 *
 * Inputs (.context/faq-pilot/): faq-a.json, faq-b.json = [{id, handle, faq_fr:[{q,a}], faq_en:[{q,a}]}];
 * faq-qa.json (verifier) = [{id, faq_fr?, faq_en?}] full replacements that win over the writers'.
 *   node-x64 --env-file=.env.local scripts/faq-pilot-apply-2026-11.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const DIR = ".context/faq-pilot";
const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;

const items = ["a", "b"].flatMap((k) => JSON.parse(fs.readFileSync(`${DIR}/faq-${k}.json`, "utf8")));
const qaPath = `${DIR}/faq-qa.json`;
for (const q of fs.existsSync(qaPath) ? JSON.parse(fs.readFileSync(qaPath, "utf8")) : []) {
  const it = items.find((x) => x.id === q.id);
  if (!it) throw new Error(`QA item for unknown id ${q.id}`);
  if (q.faq_fr) it.faq_fr = q.faq_fr;
  if (q.faq_en) it.faq_en = q.faq_en;
}

const problems = [];
for (const it of items) {
  for (const lang of ["faq_fr", "faq_en"]) {
    const list = it[lang];
    if (!Array.isArray(list) || list.length < 3 || list.length > 5) problems.push(`${it.handle} ${lang}: ${list?.length} items`);
    for (const { q, a } of list ?? []) {
      if (!q || !a || a.length > 400 || BRAND_RE.test(q + a) || /\$/.test(q + a)) problems.push(`${it.handle} ${lang}: bad item "${q}"`);
    }
  }
  if (it.faq_fr?.length !== it.faq_en?.length) problems.push(`${it.handle}: FR/EN count differ`);
}
if (problems.length) {
  console.log("INVALID:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`${items.length} products · ${items.reduce((n, i) => n + i.faq_fr.length, 0)} Q&A per language`);
if (!APPLY) {
  console.log("DRY-RUN — nothing written.");
  process.exit(0);
}

let errors = 0;
for (let i = 0; i < items.length; i += 10) {
  const metafields = items.slice(i, i + 10).flatMap((it) => [
    { ownerId: it.id, namespace: "custom", key: "faq_fr", type: "json", value: JSON.stringify(it.faq_fr) },
    { ownerId: it.id, namespace: "custom", key: "faq_en", type: "json", value: JSON.stringify(it.faq_en) },
  ]);
  const r = (await gql(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}`, { m: metafields })).data.metafieldsSet;
  if (r.userErrors.length) {
    console.log("✘", JSON.stringify(r.userErrors));
    errors++;
  }
  await sleep(500);
}
console.log(`APPLIED — ${errors} batch error(s)`);
