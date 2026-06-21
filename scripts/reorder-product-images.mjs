// Reorder Shopify product images so the Aosom white-background shot (products.image1)
// sits in position 1. Aosom hosts each image under a hash that Shopify preserves as the
// filename prefix before an optional "_<uuid>" suffix:
//   oJj57019d8cf203ee (Aosom image1)  ->  oJj57019d8cf203ee_<uuid>.jpg (Shopify CDN)
//
// Per PRODUCT (not per variant — image order is product-level):
//   - collect every variant's image1 hash (a multi-variant product has one white-bg per colour)
//   - if Shopify position-1 already matches ANY of them -> already correct
//   - else move the first matching white-bg image to position 1
//   - if none of the product's white-bg images exist on Shopify -> skip (can't reorder)
//
// Rate-limited to 2 req/sec. Dry-run by default; pass --apply to write.
//   node scripts/reorder-product-images.mjs            # dry-run, reports counts
//   node scripts/reorder-product-images.mjs --apply    # PUTs position=1
import { createClient } from "@libsql/client";
import { loadEnv, rest, sleep } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;

// hash = basename, drop query string + extension, take the part before the first "_".
const hashOf = (url) => {
  if (!url) return "";
  let b = url.split("?")[0].split("/").pop() || "";
  try { b = decodeURIComponent(b); } catch { /* keep raw */ }
  b = b.replace(/\.[a-z0-9]+$/i, ""); // strip extension
  return b.split("_")[0];
};
const RATE_MS = 500; // 2 req/sec

// 1. All imported variant rows with a white-bg image, grouped into distinct products.
const rows = await q(
  `SELECT sku, shopify_product_id, image1 FROM products
   WHERE shopify_product_id IS NOT NULL AND image1 IS NOT NULL AND image1 != ''`,
);
const products = new Map(); // pid -> { sku, hashes:Set }
for (const r of rows) {
  const pid = String(r.shopify_product_id);
  if (!products.has(pid)) products.set(pid, { sku: r.sku, hashes: new Set() });
  const h = hashOf(r.image1);
  if (h) products.get(pid).hashes.add(h);
}
console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${products.size} distinct imported products (${rows.length} variant rows)\n`);

let alreadyCorrect = 0, reordered = 0, wouldReorder = 0, whiteNotFound = 0, noImages = 0, errors = 0;

for (const [pid, p] of products) {
  let res;
  try {
    res = await rest(`/products/${pid}/images.json?fields=id,position,src`);
  } catch (e) { errors++; console.log(`${p.sku}: GET threw ${e.message || e}`); await sleep(RATE_MS); continue; }
  if (!res.ok) { errors++; console.log(`${p.sku}: GET ${res.status}`); await sleep(RATE_MS); continue; }
  const imgs = ((await res.json()).images || []).sort((a, b) => a.position - b.position);
  await sleep(RATE_MS);
  if (imgs.length === 0) { noImages++; continue; }

  // Is position-1 already one of the product's white-bg shots?
  if (p.hashes.has(hashOf(imgs[0].src))) { alreadyCorrect++; continue; }

  // Find the first Shopify image that is a white-bg shot.
  const target = imgs.find((i) => p.hashes.has(hashOf(i.src)));
  if (!target) { whiteNotFound++; console.log(`${p.sku}: white-bg image not on Shopify — skip`); continue; }

  console.log(`${p.sku}: position ${target.position} -> 1`);
  if (APPLY) {
    try {
      const put = await rest(`/products/${pid}/images/${target.id}.json`, {
        method: "PUT",
        body: JSON.stringify({ image: { id: target.id, position: 1 } }),
      });
      if (put.ok) reordered++;
      else { errors++; console.log(`   PUT ${put.status} ${(await put.text()).slice(0, 120)}`); }
    } catch (e) { errors++; console.log(`   PUT threw ${e.message || e}`); }
    await sleep(RATE_MS);
  } else {
    wouldReorder++;
  }
}

console.log(`\n=== SUMMARY (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
console.log(`  products checked:        ${products.size}`);
console.log(`  already correct:         ${alreadyCorrect}`);
console.log(`  ${APPLY ? "reordered:               " + reordered : "would reorder:           " + wouldReorder}`);
console.log(`  white-bg not on Shopify: ${whiteNotFound}`);
console.log(`  no images:               ${noImages}`);
console.log(`  errors:                  ${errors}`);
