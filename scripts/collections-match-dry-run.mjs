// Chantier 1 — DRY-RUN: how many products would match 4 proposed smart collections.
// Read-only. Fetches all Shopify products (title + productType) and applies the rules
// in JS for exact case-insensitive "contains" semantics. No collection is created.
import { gql, sleep } from "./_shopify-lib.mjs";

const Q = `query($c:String){ products(first:250, after:$c){
  pageInfo{ hasNextPage endCursor } nodes{ legacyResourceId title productType } } }`;

const products = [];
let cur = null;
while (true) {
  const { data } = await gql(Q, { c: cur });
  products.push(...data.products.nodes);
  if (!data.products.pageInfo.hasNextPage) break;
  cur = data.products.pageInfo.endCursor;
  await sleep(500);
}
console.log(`Fetched ${products.length} products.\n`);

const has = (s, words) => { const l = (s || "").toLowerCase(); return words.some((w) => l.includes(w.toLowerCase())); };

const RULES = [
  { name: "Électronique et maison", match: (p) =>
    has(p.productType, ["Electronic", "Vacuum", "Robot"]) || has(p.title, ["aspirateur", "robot", "électrique"]) },
  { name: "Décoration intérieure", match: (p) =>
    has(p.productType, ["Decor", "Mirror", "Lighting"]) || has(p.title, ["miroir", "luminaire", "lampe"]) },
  { name: "Jardin et plein air", match: (p) =>
    has(p.productType, ["Garden", "Greenhouse", "Plant"]) || has(p.title, ["jardin", "serre", "plante"]) },
  { name: "Enfants et famille", match: (p) =>
    has(p.productType, ["Kid", "Child", "Baby", "Toy"]) || has(p.title, ["enfant", "jouet", "bébé"]) },
];

for (const r of RULES) {
  const matched = products.filter(r.match);
  console.log(`\n=== ${r.name} : ${matched.length} produits ===`);
  for (const p of matched.slice(0, 5)) console.log(`   #${p.legacyResourceId}  [${p.productType || "—"}]  ${p.title}`);
}

console.log("\n=== distinct productTypes (top 25 by count) ===");
const types = {};
for (const p of products) types[p.productType || "(empty)"] = (types[p.productType || "(empty)"] || 0) + 1;
for (const [t, n] of Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   ${String(n).padStart(4)}  ${t}`);

console.log("\nDRY-RUN — aucune collection créée. STOP — en attente de validation de Mat.");
