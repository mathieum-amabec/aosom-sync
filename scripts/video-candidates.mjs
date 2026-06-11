import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";
const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const rows = (await db.execute({
  sql: `SELECT sku, shopify_product_id, shopify_handle, video, image1, name, price
        FROM products
        WHERE video IS NOT NULL AND TRIM(video) != ''
          AND shopify_product_id IS NOT NULL
          AND shopify_handle IS NOT NULL AND TRIM(shopify_handle) != ''
        ORDER BY last_seen_at DESC
        LIMIT 20`,
})).rows;
console.log(`found ${rows.length} candidates\n`);
rows.forEach((r, i) => {
  console.log(`${String(i + 1).padStart(2)}. ${r.sku} | $${r.price} | ${String(r.name).slice(0, 42)}`);
  console.log(`     handle: ${r.shopify_handle}`);
  console.log(`     video : ${r.video}`);
});
// emit JSON for the section generator (first 6)
console.log("\n---JSON6---");
console.log(JSON.stringify(rows.slice(0, 6).map((r) => ({ sku: r.sku, handle: r.shopify_handle, video: r.video, name: r.name, price: r.price, image1: r.image1 }))));
await db.close();
