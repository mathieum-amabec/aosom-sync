import { getAsset, rest } from "./_shopify-lib.mjs";
const P = "160213696617";
const mm = await getAsset("snippets/mega-menu.liquid", P);
console.log("=== FULL mega-menu.liquid ===");
console.log(mm);
console.log("\n=== enfants-related collections ===");
const smart = (await (await rest("/smart_collections.json?limit=250")).json()).smart_collections || [];
const custom = (await (await rest("/custom_collections.json?limit=250")).json()).custom_collections || [];
const all = [...smart.map(c=>({...c,kind:'smart'})), ...custom.map(c=>({...c,kind:'custom'}))];
for (const h of ["enfants", "jouets-pour-enfants", "meubles-pour-enfants"]) {
  const c = all.find(x => x.handle === h);
  if (!c) { console.log(`${h}: NOT FOUND`); continue; }
  const cnt = await (await rest(`/collections/${c.id}/products.json?limit=250&fields=id,product_type`)).json();
  const types = [...new Set((cnt.products||[]).map(p=>p.product_type))];
  console.log(`${h}: [${c.kind}] "${c.title}" | ${(cnt.products||[]).length} products | types: ${types.slice(0,8).join(", ")}`);
}
