// APPLY: mark Turso `products` rows orphaned by deleted Shopify products.
// For each of the 7 confirmed-404 product_ids, re-verify it is STILL 404 (safety),
// then UPDATE products SET shopify_product_id = NULL WHERE shopify_product_id = <id>.
// Rows are kept (no DELETE). The alive product 7750489899113 is intentionally absent.
// Dry-run by default; pass --apply to write.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com";
const API_VERSION = "2024-01";
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 7 product_ids confirmed deleted (404) via fresh API re-verification. NOT 7750489899113 (alive 200).
const DELETED = ["7736539218025", "7751702610025", "7752224604265", "7752227815529", "7796432830569", "7798394749033", "7798394912873"];

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

async function status(id) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/products/${id}.json?fields=id`, {
    headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN },
  });
  if (res.status === 429) { await sleep(2500); return status(id); }
  return res.status;
}

console.log(APPLY ? "*** APPLY MODE ***\n" : "--- DRY RUN ---\n");
const trace = { ts: null, store: STORE, marked: [] };
let total = 0;
for (const pid of DELETED) {
  const st = await status(pid);
  if (st !== 404) { console.log(`SKIP ${pid}: now returns ${st} (NOT 404) — not nulling`); continue; }
  const before = (await db.execute({ sql: "SELECT sku FROM products WHERE shopify_product_id = ?", args: [pid] })).rows.map((r) => String(r.sku));
  if (before.length === 0) { console.log(`SKIP ${pid}: already 0 rows (idempotent)`); continue; }
  if (APPLY) {
    const res = await db.execute({ sql: "UPDATE products SET shopify_product_id = NULL WHERE shopify_product_id = ?", args: [pid] });
    console.log(`UPDATED ${pid}: ${res.rowsAffected} row(s) -> NULL  | SKUs: ${before.join(", ")}`);
    total += res.rowsAffected;
  } else {
    console.log(`WOULD UPDATE ${pid}: ${before.length} row(s)  | SKUs: ${before.join(", ")}`);
    total += before.length;
  }
  trace.marked.push({ shopify_product_id: pid, skus: before });
  await sleep(300);
}
console.log(`\nTotal rows ${APPLY ? "updated" : "to update"}: ${total}`);

if (APPLY) {
  // Verify no remaining rows point at the deleted products.
  const ph = DELETED.map(() => "?").join(",");
  const remaining = (await db.execute({ sql: `SELECT COUNT(*) c FROM products WHERE shopify_product_id IN (${ph})`, args: DELETED })).rows[0].c;
  console.log(`Verify: rows still pointing at the 7 deleted product_ids = ${remaining} (want 0)`);
  // Persist the trace (old product_id -> SKUs) for reversibility / record.
  writeFileSync(new URL("./turso-orphan-trace.json", import.meta.url), JSON.stringify(trace, null, 2));
  console.log("Trace written: scripts/turso-orphan-trace.json");
}
await db.close();
