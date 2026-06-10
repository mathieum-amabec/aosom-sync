// Read-only: extract H1/H2 elements from a live PDP to pinpoint the duplicate
// title, and inspect a body_html that contains <h2>.
import { rest } from "./_shopify-lib.mjs";

const handle = "agenouilloir-jardin-pliable-mousse-eva";
const res = await fetch(`https://ameublodirect.ca/products/${handle}`);
const html = await res.text();

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1]));
console.log("=== H1 elements ===");
h1s.forEach((t, i) => console.log(`H1[${i}]: ${t.slice(0, 90)}`));

// First 6 H2s with any link inside flagged
const h2raw = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].slice(0, 8);
console.log("\n=== first H2 elements (link? = contains <a>) ===");
h2raw.forEach((m, i) => {
  const hasLink = /<a[\s>]/i.test(m[1]);
  console.log(`H2[${i}]${hasLink ? " [LINK]" : ""}: ${strip(m[1]).slice(0, 80)}`);
});

// Any literal "##" with surrounding context
const hashIdx = html.indexOf("##");
console.log(`\n"##" present in page HTML: ${hashIdx >= 0}`);
if (hashIdx >= 0) console.log("context:", html.slice(hashIdx - 60, hashIdx + 40).replace(/\s+/g, " "));

// Inspect a body_html known to contain <h2>
const pr = await rest("/products.json?limit=250&fields=id,title,handle,body_html");
const { products } = await pr.json();
const withH2 = products.find((p) => /<h2[\s>]/i.test(p.body_html || ""));
if (withH2) {
  console.log(`\n=== body_html WITH <h2>: ${withH2.title} ===`);
  console.log((withH2.body_html || "").slice(0, 500));
}
