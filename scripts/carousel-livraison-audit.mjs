// B3 audit (read-only): carousel collection overlap + "livraison gratuite" occurrences.
import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";

const cols = {
  "featured_sale → rabais": 473544622185,
  "featured_collection2 → coups-de-coeur": 473514049641,
  "featured_collection1 → mobiliers-exterieurs-et-jardins": 312997642345,
};
const ids = {};
for (const [name, id] of Object.entries(cols)) {
  const p = (await (await rest(`/collections/${id}/products.json?limit=250&fields=id`)).json()).products || [];
  ids[name] = new Set(p.map((x) => x.id));
  console.log(`${name}: ${ids[name].size} products`);
}
const names = Object.keys(ids);
const inter = (a, b) => [...a].filter((x) => b.has(x)).length;
console.log("\n=== pairwise overlap ===");
for (let i = 0; i < names.length; i++)
  for (let j = i + 1; j < names.length; j++) {
    const ov = inter(ids[names[i]], ids[names[j]]);
    console.log(`  ${names[i].split(" → ")[1]} ∩ ${names[j].split(" → ")[1]} = ${ov}`);
  }

// "livraison gratuite" occurrences across preview assets
console.log('\n=== "livraison gratuite" occurrences (preview) ===');
const assets = (await (await rest(`/themes/${PREVIEW}/assets.json`)).json()).assets;
const textKeys = assets.map((a) => a.key).filter((k) => /\.(liquid|json)$/.test(k));
let total = 0;
for (const key of textKeys) {
  let v;
  try { v = await getAsset(key, PREVIEW); } catch { continue; }
  const matches = [...v.matchAll(/livraison gratuite/gi)];
  if (!matches.length) continue;
  // For index.json show which section
  if (key === "templates/index.json") {
    const idx = JSON.parse(v);
    for (const [id, sec] of Object.entries(idx.sections)) {
      const cnt = (JSON.stringify(sec).match(/livraison gratuite/gi) || []).length;
      if (cnt) { console.log(`  ${key} → section ${id} [${sec.type}]: ${cnt}×`); total += cnt; }
    }
  } else {
    console.log(`  ${key}: ${matches.length}×`);
    total += matches.length;
  }
}
console.log(`TOTAL "livraison gratuite": ${total}`);
