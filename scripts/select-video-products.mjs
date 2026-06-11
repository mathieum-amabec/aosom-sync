import { createClient } from "@libsql/client";
import { loadEnv, rest } from "./_shopify-lib.mjs";
const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const rows = (await db.execute({
  sql: `SELECT sku, shopify_product_id AS pid, shopify_handle AS handle, video, product_type
        FROM products
        WHERE video IS NOT NULL AND TRIM(video) != '' AND shopify_product_id IS NOT NULL
          AND shopify_handle IS NOT NULL AND TRIM(shopify_handle) != ''
        ORDER BY last_seen_at DESC LIMIT 40`,
})).rows;
await db.close();

const seenHandle = new Set();
const picked = [];
for (const r of rows) {
  if (picked.length >= 6) break;
  if (seenHandle.has(r.handle)) continue;
  let st;
  try { st = (await (await rest(`/products/${r.pid}.json?fields=id,handle,status,published_at,title`)).json()).product; } catch { continue; }
  const live = st && st.status === "active" && st.published_at;
  console.log(`${live ? "✅" : "  "} ${r.sku} | status=${st?.status} published=${!!st?.published_at} | ${r.handle.slice(0, 50)}`);
  if (live) { seenHandle.add(r.handle); picked.push({ handle: r.handle, video: r.video, title: st.title, sku: r.sku }); }
}
console.log(`\nPICKED ${picked.length}:`);
console.log("---JSON---");
console.log(JSON.stringify(picked));
