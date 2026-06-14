// One-shot price reconciliation: raise Shopify variant prices that are BELOW the
// current Aosom cost (products.price) up to that cost. This unsticks the ~428 SKUs
// the per-day Phase-2 chunk queue never reached (see fix in diff-engine.ts).
//
// SAFE BY DESIGN:
//   - DRY-RUN by default. Pass --apply to actually write to Shopify.
//   - Only ever RAISES a price (Shopify < Aosom). Never lowers a price, so any
//     manual markup where Shopify > Aosom is left untouched.
//   - Strict rate limit: max 2 requests/second (500ms between writes).
//   - Logs every candidate and every write (sku, variant, old -> new).
//
// Usage:
//   node scripts/fix-prices-reconcile.mjs            # dry-run (default)
//   node scripts/fix-prices-reconcile.mjs --apply    # execute corrections
//
// Run under the x64 node on Windows ARM (libsql has no arm64 build):
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/fix-prices-reconcile.mjs

import { createClient } from "@libsql/client";
import { loadEnv, rest, sleep } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const TOLERANCE = 0.01;          // ignore sub-cent float noise
const RATE_LIMIT_MS = 500;       // 2 req/sec strict
const line = "=".repeat(72);

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

console.log(line);
console.log(`PRICE RECONCILIATION — ${APPLY ? "🔴 APPLY (writes to Shopify)" : "🟢 DRY-RUN (no writes)"}`);
console.log(line);

// 1. Aosom cost per SKU (products.price is the ingested Aosom CSV price).
const aosom = new Map();
for (const r of (await db.execute("SELECT sku, price FROM products")).rows) {
  const p = Number(r.price);
  if (r.sku && p > 0) aosom.set(String(r.sku), p);
}
console.log(`Aosom prices loaded: ${aosom.size} SKUs`);

// 2. Live Shopify variants (paginated REST). Collect id, sku, price, compare_at_price.
const variants = [];
let endpoint = "/products.json?limit=250&fields=id,status,variants";
let pages = 0;
while (endpoint && pages < 80) {
  const res = await rest(endpoint);
  if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  for (const p of body.products || []) {
    if (p.status !== "active") continue; // only reconcile live products
    for (const v of p.variants || []) {
      const vp = parseFloat(v.price);
      // Skip variants without a valid positive price — never treat a 0/NaN (data glitch)
      // as a real "below cost" price, which would otherwise get raised to cost.
      if (v.sku && vp > 0) variants.push({ id: String(v.id), sku: String(v.sku), price: vp, compareAt: v.compare_at_price ? parseFloat(v.compare_at_price) : null });
    }
  }
  pages++;
  const link = res.headers.get("Link") || res.headers.get("link");
  const next = link && link.split(",").find((s) => s.includes('rel="next"'));
  const m = next && next.match(/<([^>]+)>/);
  endpoint = m ? m[1].replace(/^https:\/\/[^/]+\/admin\/api\/[^/]+/, "") : null;
}
console.log(`Shopify active variants loaded: ${variants.length} (${pages} pages)`);

// 3. Candidates: Shopify price strictly BELOW Aosom cost.
const candidates = [];
for (const v of variants) {
  const cost = aosom.get(v.sku);
  if (cost === undefined) continue;
  if (v.price < cost - TOLERANCE) {
    candidates.push({ ...v, cost, gap: +(cost - v.price).toFixed(2) });
  }
}
candidates.sort((a, b) => b.gap - a.gap);

console.log("");
console.log(`${candidates.length} SKU(s) priced BELOW Aosom cost — to be RAISED to cost:`);
console.log(line);
let totalGap = 0;
for (const c of candidates) {
  totalGap += c.gap;
  const caNote = c.compareAt != null && c.cost >= c.compareAt ? `  [compare_at ${c.compareAt} ≤ new → will clear]` : "";
  console.log(`  ${c.sku.padEnd(16)} variant=${c.id}  $${c.price.toFixed(2)} -> $${c.cost.toFixed(2)}  (+$${c.gap.toFixed(2)})${caNote}`);
}
console.log(line);
console.log(`TOTAL: ${candidates.length} SKUs, sum of raises = $${totalGap.toFixed(2)}`);

if (!APPLY) {
  console.log("\n🟢 DRY-RUN — no changes made. Re-run with --apply to execute.");
  await db.close?.();
  process.exit(0);
}

// 4. APPLY — raise each price, strict 2 req/sec, log every write.
console.log(`\n🔴 APPLYING ${candidates.length} corrections (max 2 req/sec)…\n`);
let ok = 0, failed = 0;
for (const c of candidates) {
  const variant = { id: Number(c.id), price: c.cost.toFixed(2) };
  // Avoid an inverted "sale": if compare_at would be <= the new price, clear it.
  if (c.compareAt != null && c.cost >= c.compareAt) variant.compare_at_price = null;
  try {
    const res = await rest(`/variants/${c.id}.json`, { method: "PUT", body: JSON.stringify({ variant }) });
    if (res.ok) {
      ok++;
      console.log(`  ✓ ${c.sku.padEnd(16)} $${c.price.toFixed(2)} -> $${c.cost.toFixed(2)}`);
    } else {
      failed++;
      console.log(`  ✗ ${c.sku.padEnd(16)} HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
  } catch (e) {
    failed++;
    console.log(`  ✗ ${c.sku.padEnd(16)} ERROR: ${e.message || e}`);
  }
  await sleep(RATE_LIMIT_MS);
}

console.log("\n" + line);
console.log(`DONE — ${ok} corrected, ${failed} failed, of ${candidates.length} candidates.`);
console.log(line);
await db.close?.();
