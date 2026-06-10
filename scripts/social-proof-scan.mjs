// B4 read-only scan: real active product count + every "500" occurrence in the
// PREVIEW theme assets, with context (to find the social-proof numbers).
import { rest, getAsset, sleep } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";

// 1. Active product count
const c = await (await rest("/products/count.json?status=active")).json();
console.log("ACTIVE_PRODUCT_COUNT:", c.count);
const cAll = await (await rest("/products/count.json")).json();
console.log("ALL_PRODUCT_COUNT:", cAll.count);

// 2. Scan preview theme assets for "500"
const assets = (await (await rest(`/themes/${PREVIEW}/assets.json`)).json()).assets;
const textKeys = assets.map((a) => a.key).filter((k) => /\.(liquid|json|js)$/.test(k));
console.log(`\nscanning ${textKeys.length} text assets for "500"...\n`);
let hits = 0;
for (const key of textKeys) {
  let v;
  try { v = await getAsset(key, PREVIEW); } catch { continue; }
  await sleep(120); // gentle
  if (!v.includes("500")) continue;
  const lines = v.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("500")) {
      // flag social-proof-looking lines
      const social = /(produit|famille|client|canadien|Plus de|satisf[ae])/i.test(line);
      console.log(`${social ? "★" : " "} ${key}:${i + 1}: ${line.trim().slice(0, 140)}`);
      if (social) hits++;
    }
  });
}
console.log(`\n★ social-proof-looking "500" lines: ${hits}`);
