// Read-only: granted API scopes + sample product body_html to diagnose the
// "## literal" and "duplicate title" PDP bugs. Shopify REST/GraphQL only (no libsql).
import { loadEnv, rest, gql } from "./_shopify-lib.mjs";

const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com";
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;

// --- Granted scopes (correct endpoint: no /api/<version> prefix) ---
const sres = await fetch(`https://${STORE}/admin/oauth/access_scopes.json`, {
  headers: { "X-Shopify-Access-Token": TOKEN },
});
console.log("SCOPES status", sres.status);
if (sres.ok) {
  const d = await sres.json();
  console.log((d.access_scopes || []).map((s) => s.handle).sort().join(", "));
}

// --- Sample recent products: title + body_html, scan for markdown/heading artifacts ---
const r = await rest("/products.json?limit=15&fields=id,title,handle,body_html,status");
const { products } = await r.json();
console.log(`\nFETCHED ${products.length} products`);
let withHashHeading = 0, withH2 = 0, titleEchoed = 0;
for (const p of products) {
  const body = p.body_html || "";
  const hasHash = /(^|\n|>)\s*#{1,4}\s/.test(body) || /(^|[^&])##/.test(body);
  const hasH2 = /<h2[\s>]/i.test(body);
  const echoesTitle = p.title && body.slice(0, 200).toLowerCase().includes(p.title.toLowerCase().slice(0, 25));
  if (hasHash) withHashHeading++;
  if (hasH2) withH2++;
  if (echoesTitle) titleEchoed++;
}
console.log(`body_html with literal #-heading: ${withHashHeading}/${products.length}`);
console.log(`body_html containing <h2>: ${withH2}/${products.length}`);
console.log(`body_html echoing the product title near top: ${titleEchoed}/${products.length}`);

// Print the first body_html that has a hash-heading OR h2, for inspection.
const sample = products.find((p) => /(^|[^&])##/.test(p.body_html || "") || /<h2[\s>]/i.test(p.body_html || "")) || products[0];
console.log(`\n--- SAMPLE PRODUCT: ${sample.title} (handle: ${sample.handle}) ---`);
console.log((sample.body_html || "(empty)").slice(0, 900));
