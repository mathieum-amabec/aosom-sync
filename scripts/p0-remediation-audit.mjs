// Chantier 3 — DRY-RUN: quantify the two Phase-0 PDP findings across the live catalog.
// Read-only. (1) leading <h2>/<h3> marketing heading in body_html (the "duplicate title"
// culprit) — a DATA issue. (2) draft vs active counts (context for the draft→home "2 H1"
// artifact, which is NOT a PDP bug per the audit). No writes.
import { gql, sleep } from "./_shopify-lib.mjs";

const Q = `query($c:String){ products(first:250, after:$c){
  pageInfo{ hasNextPage endCursor }
  nodes{ legacyResourceId handle status title descriptionHtml } } }`;

const products = [];
let cur = null;
while (true) {
  const { data } = await gql(Q, { c: cur });
  products.push(...data.products.nodes);
  if (!data.products.pageInfo.hasNextPage) break;
  cur = data.products.pageInfo.endCursor;
  await sleep(500);
}
console.log(`Scanned ${products.length} products.\n`);

// status breakdown
const byStatus = {};
for (const p of products) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
console.log("=== Statut ===");
for (const [s, n] of Object.entries(byStatus)) console.log(`   ${s}: ${n}`);

// leading heading in body_html
const leadHeadingRe = /^\s*(?:<p>\s*)?<h([1-3])\b/i;
const hashRe = /(^|\n)\s*#{1,6}\s/; // literal markdown heading
const leadH = products.filter((p) => leadHeadingRe.test(p.descriptionHtml || ""));
const withHash = products.filter((p) => hashRe.test(p.descriptionHtml || ""));

console.log(`\n=== body_html commençant par <h1>/<h2>/<h3> : ${leadH.length} / ${products.length} ===`);
for (const p of leadH.slice(0, 8)) {
  const m = (p.descriptionHtml || "").match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  console.log(`   #${p.legacyResourceId} [${p.status}] ${p.handle}`);
  console.log(`      heading: ${m ? m[1].replace(/<[^>]+>/g, "").slice(0, 80) : "?"}`);
}
console.log(`\n=== body_html contenant un '##' markdown littéral : ${withHash.length} / ${products.length} ===`);
for (const p of withHash.slice(0, 5)) console.log(`   #${p.legacyResourceId} ${p.handle}`);

console.log("\nDRY-RUN — lecture seule, aucune écriture.");
