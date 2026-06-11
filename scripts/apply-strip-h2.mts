// C3 apply — strip the leading marketing heading from body_html of affected products.
// Uses the SAME stripLeadingHeading as the on-push guard (src/lib/html-utils.ts).
// 2 req/s Shopify. Idempotent (re-run = 0 changes). Logs each change.
//
// Run: node node_modules/tsx/dist/cli.mjs scripts/apply-strip-h2.mts
import { gql, sleep } from "./_shopify-lib.mjs";
import { stripLeadingHeading } from "../src/lib/html-utils";

const Q = `query($c:String){ products(first:250, after:$c){
  pageInfo{ hasNextPage endCursor } nodes{ id legacyResourceId handle descriptionHtml } } }`;
const M = `mutation($input: ProductInput!){
  productUpdate(input:$input){ product{ legacyResourceId } userErrors{ field message } } }`;

// fetch all
const products: { id: string; legacyResourceId: string; handle: string; descriptionHtml: string }[] = [];
let cur: string | null = null;
while (true) {
  const { data } = (await gql(Q, { c: cur })) as any;
  products.push(...data.products.nodes);
  if (!data.products.pageInfo.hasNextPage) break;
  cur = data.products.pageInfo.endCursor;
  await sleep(500);
}

const toFix = products.filter((p) => stripLeadingHeading(p.descriptionHtml) !== (p.descriptionHtml || ""));
console.log(`Strip leading heading — ${toFix.length} produits à corriger (sur ${products.length}).\n`);

let ok = 0, fail = 0;
for (const p of toFix) {
  const after = stripLeadingHeading(p.descriptionHtml);
  const removed = (p.descriptionHtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [, ""])[1].replace(/<[^>]+>/g, "");
  try {
    const { data } = (await gql(M, { input: { id: p.id, descriptionHtml: after } })) as any;
    const e = data.productUpdate.userErrors;
    if (e.length) { console.log(`FAIL #${p.legacyResourceId}: ${JSON.stringify(e)}`); fail++; }
    else { console.log(`OK   #${p.legacyResourceId} ${p.handle}  — retiré: « ${removed.slice(0, 70)} »`); ok++; }
  } catch (err) { console.log(`FAIL #${p.legacyResourceId}: ${(err as Error).message}`); fail++; }
  await sleep(550); // ~2 req/s
}
console.log("\n" + "─".repeat(60));
console.log(`Rapport final : ${ok}/${toFix.length} OK${fail ? `, ${fail} échec(s)` : ""}.`);
