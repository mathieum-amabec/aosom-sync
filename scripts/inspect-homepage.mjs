import { getAsset } from "./_shopify-lib.mjs";

const idx = JSON.parse(await getAsset("templates/index.json"));
const order = idx.order || [];
console.log("=== SECTION ORDER ===");
for (const id of order) {
  const s = idx.sections[id] || {};
  console.log(`- ${id}  →  type=${s.type}  disabled=${s.disabled ?? false}`);
}

console.log("\n=== SECTIONS OF INTEREST (full settings) ===");
for (const [id, s] of Object.entries(idx.sections)) {
  const t = s.type || "";
  if (/hero|featured|multicolumn|collection|why/i.test(id + " " + t)) {
    console.log(`\n### ${id} (type=${t})`);
    console.log(JSON.stringify(s.settings, null, 2));
    if (s.blocks) {
      console.log("  blocks:", Object.keys(s.blocks).length, "→", JSON.stringify(Object.entries(s.blocks).map(([k,v])=>({k,type:v.type})), null, 0));
    }
  }
}
