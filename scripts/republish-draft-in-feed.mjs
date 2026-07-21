// scripts/republish-draft-in-feed.mjs — republish products that are DRAFT on Shopify
// but present in the Aosom feed with sellable stock (qty>0 in Turso). The reactivation
// cron only handles auto-drafted products going forward; these predate the tag, so this
// is the one-time manual cleanup for the backlog.
//
// DRY-RUN by default — prints exactly what it WOULD do, writes nothing. Add --apply to
// write. Optional --skus A,B,C to restrict to a hand-picked subset.
//
//   node-x64 --env-file=.env.local scripts/republish-draft-in-feed.mjs            # dry-run all
//   node-x64 --env-file=.env.local scripts/republish-draft-in-feed.mjs --skus 838-075,921-679V00BK
//   node-x64 --env-file=.env.local scripts/republish-draft-in-feed.mjs --apply    # WRITE
import { createClient } from "@libsql/client";
import { parse } from "csv-parse/sync";

const APPLY = process.argv.includes("--apply");
const skusArg = (() => { const i = process.argv.indexOf("--skus"); return i >= 0 ? (process.argv[i + 1] || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null; })();
const CSV = process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv";
const STORE = "27u5y2-kp.myshopify.com", VER = "2025-01", TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SELLABLE_MIN = 6;          // feed qty > 5 = buffered sellable (matches stockBufferQty)
const RATE_MS = 550;             // ~2 req/s, Shopify Admin limit
const now = Math.floor(Date.now() / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = (await db.execute("SELECT sku, qty, last_seen_at, shopify_product_id FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id!='' AND qty>0")).rows;

// feed qty by SKU
const text = await (await fetch(CSV)).text();
const feedQty = new Map();
for (const r of parse(text, { columns: true, delimiter: text.split("\n")[0].includes("\t") ? "\t" : ",", skip_empty_lines: true, relax_column_count: true, trim: true }))
  if (r.SKU && r.SKU.trim()) feedQty.set(r.SKU.trim().toUpperCase(), parseInt(r.Qty, 10) || 0);

// Shopify catalog: id -> {status, title, tags}
let all = [], url = `https://${STORE}/admin/api/${VER}/products.json?limit=250&fields=id,status,title,tags`;
while (url) { const r = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } }); const j = await r.json(); all.push(...j.products); const m = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null; }
const byId = new Map(all.map((p) => [String(p.id), p]));

// Build candidate set: DRAFT product + qty>0 in Turso + at least one variant present in feed with sellable stock.
const uniq = new Map();
for (const r of rows) {
  const p = byId.get(String(r.shopify_product_id));
  if (!p || p.status !== "draft") continue;
  const pid = String(r.shopify_product_id);
  if (!uniq.has(pid)) uniq.set(pid, { pid, skus: [], lastSeen: 0, title: p.title, tags: (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean) });
  const u = uniq.get(pid); u.skus.push(String(r.sku)); u.lastSeen = Math.max(u.lastSeen, Number(r.last_seen_at || 0));
}
let candidates = [...uniq.values()].map((u) => {
  const bestFeed = Math.max(...u.skus.map((s) => feedQty.get(s.toUpperCase()) ?? -1));
  return { ...u, bestFeed, sku: u.skus[0], days: Math.round((now - u.lastSeen) / 86400),
    excludeStale: u.tags.some((t) => t.toLowerCase() === "exclude-stale") };
}).filter((c) => c.bestFeed >= SELLABLE_MIN).sort((a, b) => b.bestFeed - a.bestFeed);

if (skusArg) candidates = candidates.filter((c) => c.skus.some((s) => skusArg.includes(s.toUpperCase())));

// Planned tag transform: back-in-stock (drop out-of-stock), drop auto-drafted marker.
function planTags(tags) {
  const kept = tags.filter((t) => { const lc = t.toLowerCase(); return lc !== "out-of-stock" && lc !== "back-in-stock" && lc !== "auto-drafted"; });
  kept.push("back-in-stock");
  return kept;
}

console.log(`Mode: ${APPLY ? "APPLY (writing to Shopify)" : "DRY-RUN (no writes)"}${skusArg ? `  |  filtre --skus: ${skusArg.length}` : ""}`);
console.log(`Candidats (draft + qty>0 + feed vendable ≥${SELLABLE_MIN}): ${candidates.length}\n`);
console.log("SKU".padEnd(15) + "feed".padEnd(6) + "vu".padEnd(6) + "action                 titre");
let willWrite = 0, skipped = 0;
for (const c of candidates) {
  if (c.excludeStale) { console.log(`${c.sku.padEnd(15)}${String(c.bestFeed).padEnd(6)}${(c.days + "j").padEnd(6)}SKIP exclude-stale     ${(c.title || "").slice(0, 42)}`); skipped++; continue; }
  const newTags = planTags(c.tags);
  console.log(`${c.sku.padEnd(15)}${String(c.bestFeed).padEnd(6)}${(c.days + "j").padEnd(6)}draft→active +back-in  ${(c.title || "").slice(0, 42)}`);
  willWrite++;
}
console.log(`\n${APPLY ? "Écrits" : "Seraient republiés"}: ${willWrite}  |  skip exclude-stale: ${skipped}`);

if (APPLY) {
  console.log(`\n=== APPLYING ===`);
  let ok = 0, fail = 0;
  for (const c of candidates) {
    if (c.excludeStale) continue;
    try {
      const r = await fetch(`https://${STORE}/admin/api/${VER}/products/${c.pid}.json`, {
        method: "PUT", headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ product: { id: Number(c.pid), status: "active", tags: planTags(c.tags).join(", ") } }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      ok++; console.log(`  ✓ ${c.sku} republié`);
    } catch (e) { fail++; console.log(`  ✗ ${c.sku}: ${e.message}`); }
    await wait(RATE_MS);
  }
  console.log(`\n=== DONE: ${ok} republiés, ${fail} échecs ===`);
} else {
  console.log(`\n(Rien écrit. Pour appliquer: ajoute --apply. Pour un sous-ensemble: --skus A,B,C)`);
}
