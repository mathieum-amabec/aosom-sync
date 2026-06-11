import { getAsset } from "./_shopify-lib.mjs";
const idx = JSON.parse(await getAsset("templates/index.json", "160213696617"));
for (const id of ["lc_trustbar", "why_us"]) {
  console.log(`\n===== ${id} =====`);
  console.log(idx.sections[id].settings.custom_liquid);
}
console.log("\n===== featured_sale settings =====");
console.log(JSON.stringify(idx.sections.featured_sale.settings));
console.log("\n===== rich_text blocks =====");
for (const [bid, b] of Object.entries(idx.sections.rich_text.blocks || {})) console.log(bid, JSON.stringify(b.settings));
