// One-off repair for 2026-10-15: the 06:00 sync read the feed's missing `Price` column as 0 and wrote it over every
// stored price (products.price = 0) while logging fake "price_drop" rows (new_price = 0) in price_history.
// The pre-zero price is the old_price of those history rows, so nothing is lost.
//
//   node --env-file=.env.local scripts/repair-feed-zero-prices.mjs                # dry run (default)
//   node --env-file=.env.local scripts/repair-feed-zero-prices.mjs --apply        # write
//   --since "2026-10-15 06:00:00"  (UTC) start of the bad sync; a backup of what is changed goes to the cwd.
import { createClient } from "@libsql/client";
import fs from "node:fs";

const apply = process.argv.includes("--apply");
const sinceArg = process.argv.indexOf("--since");
const since = sinceArg > -1 ? process.argv[sinceArg + 1] : "2026-10-15 06:00:00";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const CUT = "unixepoch(?)";

const zeroRows = await q(`SELECT id, sku, old_price, new_price, change_type, detected_at FROM price_history WHERE detected_at >= ${CUT} AND (new_price IS NULL OR new_price <= 0) AND change_type != 'new_product'`, [since]);
const firstOld = new Map();
for (const r of zeroRows.sort((a, b) => Number(a.id) - Number(b.id))) {
  if (!firstOld.has(String(r.sku)) && Number(r.old_price) > 0) firstOld.set(String(r.sku), Number(r.old_price));
}
const zeroProducts = await q(`SELECT sku, price FROM products WHERE price IS NULL OR price <= 0`);
const restorable = zeroProducts.filter((p) => firstOld.has(String(p.sku)));
const byType = {};
for (const r of zeroRows) byType[r.change_type] = (byType[r.change_type] ?? 0) + 1;
console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY-RUN", since, zeroHistoryRows: zeroRows.length, byType, productsAtZero: zeroProducts.length, restorable: restorable.length, notRestorable: zeroProducts.length - restorable.length }));
console.log("sample:", JSON.stringify(restorable.slice(0, 5).map((p) => ({ sku: p.sku, from: Number(p.price), to: firstOld.get(String(p.sku)) }))));

if (!apply) process.exit(0);

fs.writeFileSync(`repair-feed-zero-prices.backup.${Date.now()}.json`, JSON.stringify({ since, zeroRows, restored: restorable.map((p) => ({ sku: p.sku, was: Number(p.price), now: firstOld.get(String(p.sku)) })) }));

const BATCH = 400;
for (let i = 0; i < restorable.length; i += BATCH) {
  await db.batch(restorable.slice(i, i + BATCH).map((p) => ({ sql: `UPDATE products SET price = ? WHERE sku = ? AND (price IS NULL OR price <= 0)`, args: [firstOld.get(String(p.sku)), String(p.sku)] })), "write");
}
// fake price drops: delete. Other rows (restock) keep their event: put the old price back as the new one.
await db.execute({ sql: `DELETE FROM price_history WHERE detected_at >= ${CUT} AND (new_price IS NULL OR new_price <= 0) AND change_type IN ('price_drop','price_increase','stock_change')`, args: [since] });
await db.execute({ sql: `UPDATE price_history SET new_price = old_price WHERE detected_at >= ${CUT} AND (new_price IS NULL OR new_price <= 0) AND old_price > 0`, args: [since] });
const after = await q(`SELECT COUNT(*) n FROM products WHERE (price IS NULL OR price <= 0) AND last_seen_at > unixepoch('now','-2 days')`);
const left = await q(`SELECT COUNT(*) n FROM price_history WHERE detected_at >= ${CUT} AND (new_price IS NULL OR new_price <= 0) AND change_type != 'new_product'`, [since]);
console.log(JSON.stringify({ productsStillAtZero: Number(after[0].n), zeroHistoryRowsLeft: Number(left[0].n) }));
