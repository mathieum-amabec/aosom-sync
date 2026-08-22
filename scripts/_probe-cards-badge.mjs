// READ-ONLY probe: verify theme roles, then dump the product-card + discount-badge
// relevant assets from the working DRAFT so we can design a "-X%" badge diff.
// Draft only, no writes. Run under node-x64.
import { rest } from "./_shopify-lib.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const DRAFT = process.argv[2] || "160749813865";
const OUT = "./.draft-scratch-cards";
mkdirSync(OUT, { recursive: true });

// 1) Verify current roles (source of truth — roles move on each publish).
const themes = (await (await rest(`/themes.json`)).json()).themes;
console.log("--- THEME ROLES (themes.json) ---");
for (const t of themes) console.log(`${t.id}  role=${t.role.padEnd(11)}  ${t.name}`);
const draftTheme = themes.find((t) => String(t.id) === String(DRAFT));
console.log(`\nTarget DRAFT ${DRAFT}: ${draftTheme ? `role=${draftTheme.role} name="${draftTheme.name}"` : "NOT FOUND"}`);
if (draftTheme && draftTheme.role === "main") {
  console.log("!!! ABORT: target is the LIVE (main) theme. Do not touch.");
  process.exit(1);
}

// 2) List asset keys, surface card/product/price/badge candidates.
const all = (await (await rest(`/themes/${DRAFT}/assets.json`)).json()).assets;
console.log(`\nTotal assets on draft: ${all.length}`);
const cand = all
  .map((a) => a.key)
  .filter((k) => /card|product-grid|price|badge|rabais|collection/i.test(k))
  .sort();
console.log("\n--- candidate card/price/badge asset keys ---");
for (const k of cand) console.log(k);

// 3) Dump the most likely card + price + grid snippets for inspection.
const wanted = [
  "snippets/card-product.liquid",
  "snippets/product-card.liquid",
  "snippets/card.liquid",
  "snippets/price.liquid",
  "snippets/product-price.liquid",
  "sections/main-collection-product-grid.liquid",
  "sections/main-product.liquid",
];
console.log("\n--- dumping (only those that exist) ---");
for (const key of wanted) {
  const res = await rest(`/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (!res.ok) {
    console.log(`SKIP ${key}: ${res.status}`);
    continue;
  }
  const a = (await res.json()).asset;
  const safe = key.replace(/[\/]/g, "__");
  writeFileSync(`${OUT}/${safe}`, a.value ?? "");
  console.log(`OK   ${key} -> ${OUT}/${safe} (${(a.value || "").length} bytes)`);
}
