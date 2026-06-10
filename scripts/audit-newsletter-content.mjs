// Read-only: dump the content of BOTH newsletter blocks + a lifestyle image candidate.
import { getAsset } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";
const THEME = "160059195497";

function dumpNewsletter(label, sec) {
  console.log(`\n=== ${label} [${sec.type}] ===`);
  console.log(`section settings: ${JSON.stringify(sec.settings)}`);
  const order = sec.block_order || Object.keys(sec.blocks || {});
  for (const bid of order) {
    const b = sec.blocks[bid];
    console.log(`  block ${b.type}: ${JSON.stringify(b.settings)}`);
  }
}

const idx = JSON.parse(await getAsset("templates/index.json", THEME));
dumpNewsletter("HOME BODY  templates/index.json -> lc_newsletter", idx.sections.lc_newsletter);
console.log(`  position in home order: index ${idx.order.indexOf("lc_newsletter")} of ${idx.order.length} (${idx.order.join(" > ")})`);

const fg = JSON.parse(await getAsset("sections/footer-group.json", THEME));
const fgNewsId = Object.keys(fg.sections).find((k) => fg.sections[k].type === "newsletter");
dumpNewsletter(`FOOTER  sections/footer-group.json -> ${fgNewsId}`, fg.sections[fgNewsId]);
console.log(`  footer-group order: ${fg.order.join(" > ")}`);

// Lifestyle image candidate (for og:image recommendation)
const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const rows = (await db.execute(
  `SELECT sku, name, image1 FROM products
   WHERE shopify_product_id IS NOT NULL
     AND (lower(image1) LIKE '%lifestyle%' OR lower(image1) LIKE '%ambiance%' OR lower(image1) LIKE '%room%'
          OR lower(image2) LIKE '%lifestyle%')
   LIMIT 5`
)).rows;
console.log("\n=== LIFESTYLE IMAGE CANDIDATES (imported products) ===");
if (!rows.length) console.log("(no lifestyle-keyword image URLs among imported products)");
for (const r of rows) console.log(`${r.sku} | ${String(r.name).slice(0,40)} | ${r.image1}`);
await db.close();
