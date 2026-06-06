import { getAsset } from "./_shopify-lib.mjs";

const idx = JSON.parse(await getAsset("templates/index.json"));
console.log("=== ORDER ===");
for (const id of idx.order || []) {
  const s = idx.sections[id] || {};
  console.log(`- ${id}  type=${s.type}`);
}

console.log("\n=== lc_hero custom_liquid ===");
console.log(JSON.stringify(idx.sections.lc_hero?.settings?.custom_liquid || "(none)"));

for (const id of ["featured_collection1", "featured_collection2"]) {
  console.log(`\n=== ${id} settings ===`);
  console.log(JSON.stringify(idx.sections[id]?.settings, null, 1));
}
