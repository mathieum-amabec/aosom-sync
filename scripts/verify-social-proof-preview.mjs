import { getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
const get = (s) => idx.sections[s].settings.custom_liquid;

const checks = [
  ["lc_hero", "Plus de 490 produits"],
  ["lc_hero", "490+ products"],
  ["lc_howit", "490+ produits"],
  ["lc_howit", "490+ products"],
  ["lc_trust", "Satisfaction garantie 30 jours"],
  ["lc_trust", "30-day satisfaction guarantee"],
];
console.log("=== new strings present ===");
for (const [s, txt] of checks) console.log(`  ${get(s).includes(txt) ? "OK" : "MISSING"}  ${s}: "${txt}"`);

const stale = ["Plus de 500 produits", "500+ products", "500+ produits", "500 familles", "Over 500 Canadian"];
console.log("\n=== stale social-proof '500' remaining (should be none) ===");
let any = false;
for (const s of ["lc_hero", "lc_howit", "lc_trust"]) {
  for (const bad of stale) if (get(s).includes(bad)) { console.log(`  STILL PRESENT in ${s}: "${bad}"`); any = true; }
}
console.log(any ? "  ^ FAIL" : "  none — clean");
