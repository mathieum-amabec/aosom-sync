#!/usr/bin/env node
/**
 * Garantie Tranquillité 2 ans — theme part (docs/garantie-tranquillite-2-ans.md).
 * Uploads snippets/lc-warranty-offer.liquid + snippets/lc-warranty-guard.liquid from the repo, adds a
 * custom_liquid block "lc_warranty" right after buy_buttons in templates/product.json, and renders the
 * guard once in layout/theme.liquid. The offer stays hidden until shop metafield custom.warranty_enabled
 * is true (or ?lc_garantie=1 for QA) and the warranty product is active.
 * Writes to an UNPUBLISHED theme only (putAsset → assertWritableTheme).
 *   node-x64 --env-file=.env.local scripts/apply-warranty-theme-2026-11-02.mjs --theme=<draftId>            # dry-run
 *   node-x64 --env-file=.env.local scripts/apply-warranty-theme-2026-11-02.mjs --theme=<draftId> --apply
 */
import fs from "node:fs";
import { getAsset, getDraftThemeId, putAsset, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const THEME_ARG = process.argv.find((a) => a.startsWith("--theme="))?.split("=")[1];
const APPLY = process.argv.includes("--apply");
const theme = await getDraftThemeId(THEME_ARG ? { themeId: THEME_ARG } : {});
console.log(`target draft: ${theme}${APPLY ? "" : " (dry-run)"}`);

const out = {
  "snippets/lc-warranty-offer.liquid": fs.readFileSync("shopify-theme/snippets/lc-warranty-offer.liquid", "utf8"),
  "snippets/lc-warranty-guard.liquid": fs.readFileSync("shopify-theme/snippets/lc-warranty-guard.liquid", "utf8"),
};

// templates/product.json: block after buy_buttons (idempotent).
const tpl = JSON.parse(await getAsset("templates/product.json", theme));
const main = tpl.sections.main;
if (!main.blocks.lc_warranty) {
  main.blocks.lc_warranty = {
    type: "custom_liquid",
    settings: { custom_liquid: "{%- render 'lc-warranty-offer', product: product, section_id: section.id -%}" },
  };
  const i = main.block_order.indexOf("buy_buttons");
  if (i < 0) throw new Error("templates/product.json: no buy_buttons block");
  main.block_order.splice(i + 1, 0, "lc_warranty");
  out["templates/product.json"] = JSON.stringify(tpl, null, 2);
} else console.log("product.json: lc_warranty block already present");

// layout/theme.liquid: render the guard once, before the assistant widget (idempotent).
const layout = await getAsset("layout/theme.liquid", theme);
if (!layout.includes("lc-warranty-guard")) {
  const anchor = "{% render 'lc-assistant-widget' %}";
  if (layout.split(anchor).length !== 2) throw new Error("theme.liquid: assistant-widget anchor not found exactly once");
  out["layout/theme.liquid"] = layout.replace(anchor, () => `{% render 'lc-warranty-guard' %}\n      ${anchor}`);
} else console.log("theme.liquid: guard already rendered");

console.log("files:", Object.keys(out).join(", "));
if (!APPLY) process.exit(0);
// Snippets first: the template/layout reference them.
for (const k of Object.keys(out).sort((a, b) => Number(b.startsWith("snippets/")) - Number(a.startsWith("snippets/")))) {
  await putAsset(k, out[k], theme);
  console.log(`✓ ${k}`);
  await sleep(600);
}
console.log(`applied to unpublished theme ${theme}`);
