// C3 — DRY-RUN: strip the leading marketing <h2> (or <h1>/<h3>) from body_html of the
// products that open with one. Read-only — shows the first 5 before/after; no writes.
import { gql, sleep } from "./_shopify-lib.mjs";

const Q = `query($c:String){ products(first:250, after:$c){
  pageInfo{ hasNextPage endCursor } nodes{ legacyResourceId handle status descriptionHtml } } }`;

const leadHeadingRe = /^\s*<h([1-3])\b[^>]*>[\s\S]*?<\/h\1>\s*/i;

const products = [];
let cur = null;
while (true) {
  const { data } = await gql(Q, { c: cur });
  products.push(...data.products.nodes);
  if (!data.products.pageInfo.hasNextPage) break;
  cur = data.products.pageInfo.endCursor;
  await sleep(500);
}

const affected = products.filter((p) => leadHeadingRe.test(p.descriptionHtml || ""));
console.log(`C3 DRY-RUN — produits avec heading en tête de body_html : ${affected.length} / ${products.length}\n`);

const snip = (s, n = 160) => (s || "").replace(/\s+/g, " ").slice(0, n) + ((s || "").length > n ? "…" : "");
for (const p of affected.slice(0, 5)) {
  const before = p.descriptionHtml;
  const after = before.replace(leadHeadingRe, "");
  const removed = (before.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [, ""])[1].replace(/<[^>]+>/g, "");
  console.log(`#${p.legacyResourceId} [${p.status}] ${p.handle}`);
  console.log(`   heading retiré : « ${removed.slice(0, 90)} »`);
  console.log(`   AVANT : ${snip(before)}`);
  console.log(`   APRÈS : ${snip(after)}`);
  console.log("");
}
console.log("─".repeat(70));
console.log(`Total à corriger : ${affected.length}`);
console.log("DRY-RUN — aucune écriture. STOP — en attente de validation de Mat avant apply.");
