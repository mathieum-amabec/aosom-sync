// Read-only: list draft asset keys + dump the assets relevant to this fix session
// to a local scratch dir for inspection. Draft theme ONLY.
import { rest } from "./_shopify-lib.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const DRAFT = "160606093417";
const OUT = process.argv[2] || "./.draft-scratch";
mkdirSync(OUT, { recursive: true });

const all = (await (await rest(`/themes/${DRAFT}/assets.json`)).json()).assets;
console.log(`Total assets: ${all.length}`);

// Show candidate keys for each problem area.
const interesting = all
  .map((a) => a.key)
  .filter((k) => /index\.json|cat_tiles|video|collection-product-grid|header|mega|menu|hero/i.test(k))
  .sort();
console.log("\n--- candidate asset keys ---");
for (const k of interesting) console.log(k);

// Dump specific ones we know we need.
const wanted = [
  "templates/index.json",
  "sections/cat_tiles.liquid",
  "sections/home-video-showcase.liquid",
  "sections/main-collection-product-grid.liquid",
  "sections/header.liquid",
];
console.log("\n--- dumping ---");
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
