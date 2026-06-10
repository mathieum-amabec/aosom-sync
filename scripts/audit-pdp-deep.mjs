// Read-only deep dive: find products whose body_html (or EN metafield) contains
// literal "##", and fetch a live PDP to inspect the duplicate-title DOM.
import { loadEnv, rest } from "./_shopify-lib.mjs";

const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com";

// --- Scan up to ~250 products for "##" in body_html ---
let pageInfo = null, scanned = 0, hashHits = [], h2Hits = [];
let url = "/products.json?limit=250&fields=id,title,handle,body_html";
const r = await rest(url);
const { products } = await r.json();
scanned = products.length;
for (const p of products) {
  const b = p.body_html || "";
  if (/##/.test(b)) hashHits.push(p.handle);
  if (/<h2[\s>]/i.test(b)) h2Hits.push(p.handle);
}
console.log(`SCANNED=${scanned}  body_html_with_##=${hashHits.length}  body_html_with_<h2>=${h2Hits.length}`);
if (hashHits.length) console.log("## handles:", hashHits.slice(0, 10).join(", "));
if (h2Hits.length) console.log("<h2> handles:", h2Hits.slice(0, 10).join(", "));

// --- Check EN metafield body_html_en for ## on a few products ---
console.log("\n--- EN metafield scan (first 8 products) ---");
let metaHash = 0;
for (const p of products.slice(0, 8)) {
  const mr = await rest(`/products/${p.id}/metafields.json?namespace=custom`);
  const { metafields } = await mr.json();
  const bodyEn = (metafields || []).find((m) => m.key === "body_html_en");
  const titleEn = (metafields || []).find((m) => m.key === "title_en");
  if (bodyEn && /##/.test(bodyEn.value || "")) { metaHash++; console.log(`  ${p.handle}: body_html_en HAS ##`); }
}
console.log(`EN metafields with ## (of 8): ${metaHash}`);

// --- Fetch a live PDP and count title occurrences + ## ---
const sample = products[0];
for (const domain of ["ameublodirect.ca", "27u5y2-kp.myshopify.com"]) {
  try {
    const res = await fetch(`https://${domain}/products/${sample.handle}`, { redirect: "follow" });
    const html = await res.text();
    if (!res.ok) { console.log(`\nPDP ${domain} status ${res.status}`); continue; }
    const title = sample.title;
    const titleCount = html.split(title).length - 1;
    const h1 = (html.match(/<h1[\s>]/gi) || []).length;
    const h2 = (html.match(/<h2[\s>]/gi) || []).length;
    const hashInPage = (html.match(/##/g) || []).length;
    console.log(`\nPDP ${domain} (${sample.handle}) status ${res.status}`);
    console.log(`  title "${title.slice(0,40)}" appears ${titleCount}x | <h1>=${h1} <h2>=${h2} | "##" count=${hashInPage}`);
    break;
  } catch (e) { console.log(`PDP ${domain} error: ${e.message}`); }
}
