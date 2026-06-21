// One-shot: draft Shopify products that are imported, still in stock (qty>0), but have not
// appeared in the Aosom CSV for >14 days (likely discontinued → oversell risk).
//
//   node scripts/fix-stale-products.mjs            # DRY-RUN (lists candidates, no writes)
//   node scripts/fix-stale-products.mjs --apply    # PUT status='draft' on Shopify (rate-limited)
//
// Run under node x64 (global fetch). Reads TURSO_* + SHOPIFY_ACCESS_TOKEN from .env.local.
// Backup of the original Shopify status is written BEFORE any write so it can be restored.
import { createClient } from "@libsql/client";
import { loadEnv, rest, STORE, sleep } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const STALE_DAYS = 14;
const RATE_MS = 500; // 2 requests/second
const BACKUP = "scripts/reports/fix-stale-products-backup.json";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const rows = (await db.execute(
  `SELECT sku, name, qty, shopify_product_id,
     last_seen_at, CAST((unixepoch() - last_seen_at) / 86400 AS INT) AS days_stale
   FROM products
   WHERE shopify_product_id IS NOT NULL AND qty > 0 AND last_seen_at < unixepoch() - 86400 * ${STALE_DAYS}
   ORDER BY last_seen_at ASC`,
)).rows;
await db.close();

const date = (e) => (e == null ? "?" : new Date(Number(e) * 1000).toISOString().slice(0, 10));
console.log(`Mode: ${APPLY ? "APPLY (drafting on Shopify)" : "DRY-RUN"}`);
console.log(`Store: ${STORE} | candidates (imported, qty>0, >${STALE_DAYS}d stale): ${rows.length}\n`);

mkdirSync("scripts/reports", { recursive: true });

if (!APPLY) {
  console.log("First 10 (oldest first):");
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${date(r.last_seen_at)} | ${String(r.days_stale).padStart(3)}d | qty=${String(r.qty).padStart(3)} | ${r.sku} | ${String(r.name || "").slice(0, 50)}`);
  }
  console.log(`\n…${rows.length} total. Candidate list written: ${BACKUP}`);
  writeFileSync(BACKUP, JSON.stringify(rows, null, 2), "utf8");
  console.log("DRY-RUN only — re-run with --apply to draft them on Shopify.");
  process.exit(0);
}

// ── APPLY ──────────────────────────────────────────────────────────────────
// Pass 1: capture each product's CURRENT Shopify status, write the backup BEFORE any write.
const backup = [];
for (const r of rows) {
  let prev = "unknown";
  try {
    const g = await rest(`/products/${r.shopify_product_id}.json?fields=id,status`);
    if (g.ok) prev = (await g.json()).product?.status ?? "unknown";
  } catch (e) { console.log(`WARN get status ${r.sku}: ${e.message}`); }
  backup.push({ sku: r.sku, shopify_product_id: String(r.shopify_product_id), previous_status: prev, qty: r.qty, last_seen_at: r.last_seen_at, days_stale: r.days_stale });
  await sleep(RATE_MS);
}
writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
console.log(`Backup (original statuses) written BEFORE any write: ${BACKUP} (${backup.length} rows)\n`);

// Pass 2: draft the ones still active.
let drafted = 0, skipped = 0, failed = 0;
for (const b of backup) {
  if (b.previous_status === "draft" || b.previous_status === "archived") {
    console.log(`Skipped: ${b.sku} (already ${b.previous_status})`); skipped++; continue;
  }
  try {
    const res = await rest(`/products/${b.shopify_product_id}.json`, {
      method: "PUT",
      body: JSON.stringify({ product: { id: Number(b.shopify_product_id), status: "draft" } }),
    });
    if (res.ok) { drafted++; console.log(`Drafted: ${b.sku} (last seen ${b.days_stale} days ago)`); }
    else { failed++; console.log(`FAILED: ${b.sku} -> ${res.status} ${(await res.text()).slice(0, 120)}`); }
  } catch (e) { failed++; console.log(`FAILED: ${b.sku} -> ${e.message}`); }
  await sleep(RATE_MS);
}
console.log(`\nDone. Drafted=${drafted} Skipped=${skipped} Failed=${failed} of ${backup.length}`);
console.log(`Restore: re-PUT status from ${BACKUP} (previous_status per id).`);
