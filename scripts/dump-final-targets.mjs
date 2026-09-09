import { getAsset, getDraftThemeId } from "./_shopify-lib.mjs";

// Theme ids are resolved from themes.json at run time — never hardcoded.
const DRAFT_THEME_ID = await getDraftThemeId();
const idx = JSON.parse(await getAsset("templates/index.json", DRAFT_THEME_ID));
for (const id of ["lc_trustbar", "why_us"]) {
  console.log(`\n===== ${id} =====`);
  console.log(idx.sections[id].settings.custom_liquid);
}
console.log("\n===== featured_sale settings =====");
console.log(JSON.stringify(idx.sections.featured_sale.settings));
console.log("\n===== rich_text blocks =====");
for (const [bid, b] of Object.entries(idx.sections.rich_text.blocks || {})) console.log(bid, JSON.stringify(b.settings));
