// READ-ONLY STEP 3: fetch the FAQ liquid + find where it's rendered on the product page.
import { readFileSync } from "node:fs";
function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", LIVE = "160606093417";
const H = { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN };
async function asset(key) { const r = await fetch(`https://${STORE}/admin/api/${API}/themes/${LIVE}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: H }); return r.ok ? (await r.json()).asset.value : null; }

const target = process.argv[2] || "snippets/agentic-faq.liquid";
const v = await asset(target);
console.log(`===== ${target} (${v ? v.length + " bytes" : "MISSING"}) =====`);
console.log(v || "(not found)");

// find which assets render it + which sections mention faq
const all = (await (await fetch(`https://${STORE}/admin/api/${API}/themes/${LIVE}/assets.json`, { headers: H })).json()).assets.map((a) => a.key);
console.log(`\n===== assets that reference 'agentic-faq' or 'faq' (scanning sections/templates/snippets) =====`);
const scan = all.filter((k) => /^(sections|templates|snippets|layout)\//.test(k) && /\.(liquid|json)$/.test(k));
for (const k of scan) {
  const c = await asset(k);
  if (c && /agentic-faq|'faq'|"faq"|render 'faq|product-faq/i.test(c)) {
    const hits = (c.match(/.*(agentic-faq|faq).*/gi) || []).slice(0, 3).map((s) => s.trim().slice(0, 120));
    console.log(`  ${k}:`);
    for (const h of hits) console.log(`     ${h}`);
  }
}
