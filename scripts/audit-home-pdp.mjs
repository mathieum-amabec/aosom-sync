// Read-only: home template section selection (Q5) + a real PUBLISHED PDP (Q4).
import { rest, getAsset } from "./_shopify-lib.mjs";

const THEME = "160059195497";

// --- Q5: home template sections + how the carousels pick products ---
const idx = JSON.parse(await getAsset("templates/index.json", THEME));
console.log("=== HOME SECTION ORDER ===");
console.log(idx.order.join(", "));
console.log("\n=== SECTION TYPES + product-selection settings ===");
for (const [id, sec] of Object.entries(idx.sections)) {
  const s = sec.settings || {};
  const picks = {};
  for (const k of Object.keys(s)) {
    if (/collection|product|sort|limit|count|max|show|sold|stock|avail/i.test(k)) picks[k] = s[k];
  }
  const heading = s.heading || s.title || "";
  console.log(`- ${id} [${sec.type}]${heading ? ` "${heading}"` : ""}`);
  if (Object.keys(picks).length) console.log(`    ${JSON.stringify(picks)}`);
  if (sec.blocks) {
    const types = [...new Set(Object.values(sec.blocks).map((b) => b.type))];
    console.log(`    blocks: ${types.join(", ")} (n=${Object.keys(sec.blocks).length})`);
  }
}

// --- Q4: fetch a PUBLISHED PDP and inspect H1/H2 + ## ---
const pr = await rest("/products.json?published_status=published&status=active&limit=5&fields=id,title,handle,body_html");
const { products } = await pr.json();
console.log(`\n=== PUBLISHED products found: ${products.length} ===`);
const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
for (const p of products.slice(0, 2)) {
  const res = await fetch(`https://ameublodirect.ca/products/${p.handle}`);
  const html = await res.text();
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1])).filter(Boolean);
  const finalUrl = res.url;
  console.log(`\nPDP ${p.handle} -> ${finalUrl} (status ${res.status})`);
  console.log(`  H1 count=${h1s.length}: ${JSON.stringify(h1s.map((t) => t.slice(0, 50)))}`);
  console.log(`  "##" in page: ${html.includes("##")}`);
  // product-title heading occurrences near the product section
  const tCount = strip(html).split(p.title).length - 1;
  console.log(`  product title "${p.title.slice(0,35)}" appears ${tCount}x in stripped text`);
}
