#!/usr/bin/env node
/**
 * Furnish Direct conversion audit (2026-11-01), theme part: on the `en` locale (furnishdirect.ca), the
 * shopper-facing brand is Furnish Direct, not Ameublo Direct. FR is untouched (every change is behind
 * `locale == 'en'`). Optionally also ships the Black Friday banner from the repo (PR #674).
 *
 * Patches are exact substrings applied to the CURRENT live files (the repo snapshot of the theme is stale),
 * then written to an UNPUBLISHED theme only (putAsset → assertWritableTheme).
 *   node-x64 --env-file=.env.local scripts/apply-furnish-brand-theme-2026-11-01.mjs                       # dry-run: patched files → .context/furnish-fix/patched/
 *   node-x64 --env-file=.env.local scripts/apply-furnish-brand-theme-2026-11-01.mjs --theme=<draftId> [--with-bf-banner]
 */
import fs from "node:fs";
import path from "node:path";
import { getAsset, getLiveThemeId, putAsset, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const THEME = Number(process.argv.find((a) => a.startsWith("--theme="))?.split("=")[1]) || null;
const WITH_BF = process.argv.includes("--with-bf-banner");
const EN = "request.locale.iso_code == 'en'";

const PATCHES = {
  // The shop name is now "Ameublo Direct | Furnish Direct" so the checkout, Apple Pay and order emails name both
  // stores. On the storefront each locale keeps its own brand instead of the combined name.
  "layout/theme.liquid": [
    ["{%- unless page_title contains shop.name or page_title contains 'Furnish Direct' %}", "{%- unless page_title contains 'Ameublo Direct' or page_title contains 'Furnish Direct' %}"],
    ["{% elsif lc_loc == 'pa' %}Furnish Direct{% else %}{{ shop.name }}{% endif %}{% endunless -%}", "{% elsif lc_loc == 'pa' %}Furnish Direct{% else %}Ameublo Direct{% endif %}{% endunless -%}"],
  ],
  "snippets/meta-tags.liquid": [["assign og_site_name = shop.name", "assign og_site_name = 'Ameublo Direct'"]],
  "snippets/lc-org-schema.liquid": [
    [`"name": {{ shop.name | json }},\n  "alternateName": ["Furnish Direct", "Ameublo"],`, `"name": "Ameublo Direct",\n  "alternateName": ["Furnish Direct", "Ameublo"],`],
    [`"name": {{ shop.name | json }},\n  "alternateName": "Furnish Direct",`, `"name": "Ameublo Direct",\n  "alternateName": "Furnish Direct",`],
  ],
  "snippets/lc-page-schema.liquid": [
    [`"author": { "@type": "Organization", "@id": {{ org_id | json }}, "name": {{ shop.name | json }},`, `"author": { "@type": "Organization", "@id": {{ org_id | json }}, "name": "Ameublo Direct",`],
    [`"publisher": { "@type": "Organization", "@id": {{ org_id | json }}, "name": {{ shop.name | json }},`, `"publisher": { "@type": "Organization", "@id": {{ org_id | json }}, "name": "Ameublo Direct",`],
  ],
  // Footer brand column heading ("AMEUBLO DIRECT") and copyright (shop.name is the single shop name).
  "sections/footer.liquid": [
    [`<h2 class="footer-block__heading inline-richtext">{{- block.settings.heading -}}</h2>`,
      `<h2 class="footer-block__heading inline-richtext">{%- if ${EN} and block.settings.heading contains 'Ameublo' -%}Furnish Direct{%- else -%}{{- block.settings.heading -}}{%- endif -%}</h2>`],
    [`&copy; {{ 'now' | date: '%Y' }}, {{ shop.name | link_to: routes.root_url -}}`,
      `&copy; {{ 'now' | date: '%Y' }}, {% if ${EN} %}{{ 'Furnish Direct' | link_to: routes.root_url -}}{% else %}{{ 'Ameublo Direct' | link_to: routes.root_url -}}{% endif -%}`],
  ],
  "sections/lc-newsletter.liquid": [
    ["By signing up you agree to receive emails from Ameublo Direct.", "By signing up you agree to receive emails from Furnish Direct (Ameublo Direct)."],
  ],
  // "The Ameublo Guide" (desktop menu + mobile drawer) → "The Furnish Guide" on every non-French locale.
  "snippets/header-mega-menu.liquid": [["assign guide_label = 'The Ameublo Guide'", "assign guide_label = 'The Furnish Guide'"]],
  "snippets/header-drawer.liquid": [["assign guide_label = 'The Ameublo Guide'", "assign guide_label = 'The Furnish Guide'"]],
  // Product JSON-LD brand (was shop.name, now the combined name) → Ameublo Direct, Furnish Direct on en.
  "snippets/lc-structured-data.liquid": [["    assign brand = shop.name\n", `    assign brand = 'Ameublo Direct'\n    if ${EN}\n      assign brand = 'Furnish Direct'\n    endif\n`]],
  // This file uses CRLF line endings: no trailing newline in the match.
  "snippets/agentic-structured-data.liquid": [["  assign brand = shop.name", `  assign brand = 'Ameublo Direct'\n  if ${EN}\n    assign brand = 'Furnish Direct'\n  endif`]],
  // Homepage reviews are written in French by Quebec customers: keep them (real social proof) but say so.
  "snippets/lc_judgeme_all_reviews.liquid": [[
    `        li.appendChild(b);`,
    `        if (txt && EN) b.appendChild(el("p", "lc-rv__orig", lcT(LG,"Original review in French","","Reseña original en francés","ਮੂਲ ਰਿਵੀਊ ਫ਼ਰਾਂਸੀਸੀ ਵਿੱਚ")));
        li.appendChild(b);`,
  ],[".lc-rv__body{min-width:0;}", ".lc-rv__body{min-width:0;}\n  .lc-rv__orig{margin:.15rem 0 0;font-size:.75rem;opacity:.65;font-style:italic;}"]],
};

// Base = the target draft when given (a fresh duplicate of live: keeps any change already in that draft), else live.
const live = await getLiveThemeId();
const base = THEME || live;
const out = {};
for (const [key, list] of Object.entries(PATCHES)) {
  let v = await getAsset(key, base);
  for (const [from, to] of list) {
    const n = v.split(from).length - 1;
    if (n !== 1) throw new Error(`${key}: patch matched ${n}× (expected 1): ${from.slice(0, 70)}`);
    v = v.replace(from, () => to);
  }
  out[key] = v;
  await sleep(300);
}
if (WITH_BF) out["sections/lc-announcement.liquid"] = fs.readFileSync("shopify-theme/sections/lc-announcement.liquid", "utf8");

for (const [k, v] of Object.entries(out)) {
  const f = path.join(".context/furnish-fix/patched", k);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, v);
}
console.log(`live ${live} · base ${base} · ${Object.keys(out).length} files patched → .context/furnish-fix/patched/`);
if (!THEME) { console.log("DRY-RUN — nothing written to Shopify."); process.exit(0); }

let errors = 0;
for (const [k, v] of Object.entries(out)) {
  await putAsset(k, v, THEME); // throws unless THEME is unpublished
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) { await sleep(1500); ok = (await getAsset(k, THEME)) === v; } // Shopify serves the old asset for a few seconds
  console.log(ok ? "✔" : "✘ read-back differs", k);
  if (!ok) errors++;
}
console.log(`APPLIED to ${THEME} — ${errors} error(s)`);
