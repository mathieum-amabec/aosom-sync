import { getAsset } from "./_shopify-lib.mjs";
const idx = JSON.parse(await getAsset("templates/index.json", "160213696617"));
for (const id of ["lc_story2", "lc_trust", "lc_howit", "shop_pay_home"]) {
  const cl = idx.sections[id].settings.custom_liquid;
  console.log(`\n===== ${id} (len ${cl.length}) =====`);
  console.log(cl);
}
// rich_text block(s)
const rt = idx.sections.rich_text;
console.log(`\n===== rich_text blocks =====`);
for (const [bid, b] of Object.entries(rt.blocks || {})) {
  console.log(`[${b.type}] ${JSON.stringify(b.settings)}`);
}
