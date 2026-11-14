#!/usr/bin/env node
/**
 * LPC art. 38.1 / 38.8 (in force 2026-10-05): fridges, freezers, ACs (6 years) and washers, dryers, dishwashers
 * (5 years) carry a legal warranty of good working order whose duration must be shown near the price.
 *  1. Tags the 65 appliances listed in docs/data/appliances-garantie-legale-2026-11-02.csv with
 *     garantie-legale-6ans / garantie-legale-5ans (tagsAdd — additive, idempotent).
 *  2. On an UNPUBLISHED theme: the price checklist line and the "Garantie" accordion show
 *     "Garantie légale de bon fonctionnement : N ans" on those products instead of "Garantie fabricant 1 an".
 *     (The paid Garantie Tranquillité snippet already skips garantie-legale-* tags.)
 *   node-x64 --env-file=.env.local scripts/apply-legal-warranty-appliances-2026-11-02.mjs --theme=<draftId>          # dry-run
 *   node-x64 --env-file=.env.local scripts/apply-legal-warranty-appliances-2026-11-02.mjs --theme=<draftId> --apply
 */
import fs from "node:fs";
import { gql, getAsset, getDraftThemeId, putAsset, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const THEME_ARG = process.argv.find((a) => a.startsWith("--theme="))?.split("=")[1];

const rows = fs.readFileSync("docs/data/appliances-garantie-legale-2026-11-02.csv", "utf8").trim().split(/\r?\n/).slice(1)
  .map((l) => { const [id, handle, category, tag] = l.split(","); return { id, handle, category, tag }; });
if (rows.some((r) => !/^gid:\/\/shopify\/Product\/\d+$/.test(r.id) || !/^garantie-legale-[56]ans$/.test(r.tag))) throw new Error("bad CSV row");
console.log(`${rows.length} appliances: ${rows.filter((r) => r.tag.endsWith("6ans")).length} × 6 ans, ${rows.filter((r) => r.tag.endsWith("5ans")).length} × 5 ans`);

// Theme patches (exact substrings; CRLF-aware)
const YEARS = `{%- assign lc_gl = 0 -%}{%- if product.tags contains 'garantie-legale-6ans' -%}{%- assign lc_gl = 6 -%}{%- elsif product.tags contains 'garantie-legale-5ans' -%}{%- assign lc_gl = 5 -%}{%- endif -%}`;
const theme = await getDraftThemeId(THEME_ARG ? { themeId: THEME_ARG } : {});
const files = {};
{
  const key = "sections/main-product.liquid";
  let v = await getAsset(key, theme);
  const from = `<li>{%- if lc_loc == 'en' -%}1-year manufacturer warranty{%- elsif lc_loc == 'es' -%}Garantía del fabricante de 1 año{%- elsif lc_loc == 'pa' -%}1-ਸਾਲ ਦੀ ਨਿਰਮਾਤਾ ਵਾਰੰਟੀ{%- else -%}Garantie fabricant 1 an{%- endif -%}</li>`;
  const to = `${YEARS}{%- if lc_gl > 0 -%}<li>{%- if lc_loc == 'en' or lc_loc == 'pa' -%}Legal warranty of good working order: {{ lc_gl }} years{%- elsif lc_loc == 'es' -%}Garantía legal de buen funcionamiento: {{ lc_gl }} años{%- else -%}Garantie légale de bon fonctionnement : {{ lc_gl }} ans{%- endif -%}</li>{%- else -%}${from}{%- endif -%}`;
  if (v.split(from).length !== 2) throw new Error(`${key}: checklist line not found exactly once`);
  files[key] = v.replace(from, () => to);
}
{
  const key = "templates/product.json";
  const tpl = JSON.parse(await getAsset(key, theme));
  const b = tpl.sections.main.blocks.pdp_info.settings;
  const from = `<div class="lc-acc__b"><p>{% if loc == 'en' %}1-year manufacturer warranty included.`;
  const to = `<div class="lc-acc__b">${YEARS}{% if lc_gl > 0 %}<p><strong>{% if loc == 'en' or loc == 'pa' %}Legal warranty of good working order: {{ lc_gl }} years (Quebec Consumer Protection Act).{% elsif loc == 'es' %}Garantía legal de buen funcionamiento: {{ lc_gl }} años (Ley de protección del consumidor de Quebec).{% else %}Garantie légale de bon fonctionnement : {{ lc_gl }} ans (Loi sur la protection du consommateur).{% endif %}</strong></p>{% endif %}<p>{% if loc == 'en' %}1-year manufacturer warranty included.`;
  if (b.custom_liquid.split(from).length !== 2) throw new Error(`${key}: pdp_info warranty paragraph not found exactly once`);
  b.custom_liquid = b.custom_liquid.replace(from, () => to);
  files[key] = JSON.stringify(tpl, null, 2);
}
files["snippets/lc-warranty-offer.liquid"] = fs.readFileSync("shopify-theme/snippets/lc-warranty-offer.liquid", "utf8");

console.log(`theme ${theme}: ${Object.keys(files).join(", ")}${APPLY ? "" : " (dry-run)"}`);
if (!APPLY) process.exit(0);

let ok = 0;
for (const r of rows) {
  const res = await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: r.id, tags: [r.tag] });
  const errs = res.data.tagsAdd.userErrors;
  if (errs.length) console.error(`✗ ${r.handle}: ${JSON.stringify(errs)}`); else ok++;
  await sleep(550);
}
console.log(`tags: ${ok}/${rows.length}`);
for (const k of ["snippets/lc-warranty-offer.liquid", "sections/main-product.liquid", "templates/product.json"]) {
  await putAsset(k, files[k], theme);
  console.log(`✓ ${k}`);
  await sleep(600);
}
