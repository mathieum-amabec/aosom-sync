// scripts/zero-inventory-oos.mjs — force Shopify inventory to 0 for ACTIVE, tracked
// variants that Aosom can no longer ship: SKU absent from the feed OR feed_qty=0.
// With inventory_policy=deny this makes the variant un-buyable WITHOUT drafting the
// product (variant-level → live siblings keep selling; no SEO/URL loss). Closes the
// oversell that `deny` can't, because Shopify inventory was frozen at old buffered values.
//
// DRY-RUN by default (prints the plan, writes nothing). --apply writes. --include-low
// also zeroes feed_qty 1..THRESHOLD (default off; this run targets absent OR feed=0 only).
//
//   node-x64 --env-file=.env.local scripts/zero-inventory-oos.mjs            # dry-run
//   node-x64 --env-file=.env.local scripts/zero-inventory-oos.mjs --apply    # WRITE
import { parse } from "csv-parse/sync";

const APPLY = process.argv.includes("--apply");
// Threshold: zero inventory for feed_qty <= THRESHOLD (absent always counts). Default 0
// (= absent OR feed_qty=0). Pass `--le 10` to also cover the 1..10 danger zone.
const THRESHOLD = (() => { const i = process.argv.indexOf("--le"); return i >= 0 ? (parseInt(process.argv[i + 1], 10) || 0) : 0; })();
const CSV = process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv";
const STORE = "27u5y2-kp.myshopify.com", VER = "2025-01", TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const H = { "X-Shopify-Access-Token": TOKEN };
const RATE_MS = 550;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Feed: sku -> qty
const text = await (await fetch(CSV)).text();
const feedQty = new Map();
for (const r of parse(text, { columns: true, delimiter: text.split("\n")[0].includes("\t") ? "\t" : ",", skip_empty_lines: true, relax_column_count: true, trim: true }))
  if (r.SKU && r.SKU.trim()) feedQty.set(r.SKU.trim().toUpperCase(), parseInt(r.Qty, 10) || 0);

// Active Shopify products + variants (need inventory_item_id + management + qty)
let all = [], url = `https://${STORE}/admin/api/${VER}/products.json?limit=250&status=active&fields=id,title,variants`;
while (url) { const r = await fetch(url, { headers: H }); const j = await r.json(); all.push(...j.products); const m = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null; }

const candidates = [];
for (const p of all) {
  for (const v of p.variants || []) {
    const sku = (v.sku || "").toUpperCase();
    if (!sku) continue;
    if (v.inventory_management !== "shopify") continue;      // not tracked → setInventoryLevel is a no-op
    if (Number(v.inventory_quantity) <= 0) continue;         // already 0 → nothing to do
    const inFeed = feedQty.has(sku);
    const fq = inFeed ? feedQty.get(sku) : null;
    const target = !inFeed || fq <= THRESHOLD;               // absent OR feed_qty <= THRESHOLD
    if (!target) continue;
    candidates.push({ sku: v.sku, title: p.title, inv: Number(v.inventory_quantity), invItem: String(v.inventory_item_id || ""), policy: v.inventory_policy, feed: inFeed ? String(fq) : "ABS" });
  }
}
candidates.sort((a, b) => b.inv - a.inv);

console.log(`Mode: ${APPLY ? "APPLY (writing inventory=0)" : "DRY-RUN (no writes)"}  |  seuil: absent OU feed_qty <= ${THRESHOLD}`);
console.log(`Variantes actives trackées, achetables (inv>0), absentes OU feed_qty<=${THRESHOLD}: ${candidates.length}`);
console.log(`Unités d'inventaire fantôme total: ${candidates.reduce((s, c) => s + c.inv, 0)}\n`);
console.log("SKU".padEnd(16) + "inv→0".padEnd(8) + "feed".padEnd(6) + "policy".padEnd(10) + "titre");
for (const c of candidates) console.log(`${c.sku.padEnd(16)}${String(c.inv).padEnd(8)}${c.feed.padEnd(6)}${(c.policy || "").padEnd(10)}${(c.title || "").slice(0, 40)}`);
const noItem = candidates.filter((c) => !c.invItem).length;
if (noItem) console.log(`\n⚠ ${noItem} sans inventory_item_id (impossible à écrire) — seront skippés à l'--apply.`);

if (!APPLY) {
  console.log(`\n(Rien écrit. --apply pour écrire. Note: policy=deny + inv=0 = variante inachetable, produit reste publié.)`);
  process.exit(0);
}

// --apply: resolve primary location, then inventory_levels/set to 0
const locRes = await fetch(`https://${STORE}/admin/api/${VER}/locations.json?fields=id,active,name`, { headers: H });
const locs = (await locRes.json()).locations || [];
const loc = locs.find((l) => l.active) || locs[0];
if (!loc) { console.error("no location found"); process.exit(1); }
console.log(`\n=== APPLYING at location ${loc.name} (${loc.id}) ===`);
let ok = 0, fail = 0;
for (const c of candidates) {
  if (!c.invItem) { fail++; console.log(`  ✗ ${c.sku}: no inventory_item_id`); continue; }
  try {
    const r = await fetch(`https://${STORE}/admin/api/${VER}/inventory_levels/set.json`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ location_id: loc.id, inventory_item_id: Number(c.invItem), available: 0 }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    ok++; console.log(`  ✓ ${c.sku} inv ${c.inv}→0`);
  } catch (e) { fail++; console.log(`  ✗ ${c.sku}: ${e.message}`); }
  await wait(RATE_MS);
}
console.log(`\n=== DONE: ${ok} zéros, ${fail} échecs ===`);
