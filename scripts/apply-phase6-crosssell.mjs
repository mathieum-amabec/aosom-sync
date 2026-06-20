// Phase 6 C2 — curated PDP cross-sell. PREVIEW only (160213696617).
// The PDP already has a `related-products` section (Shopify category-aware recommendations,
// `intent: related`, rendered with the same card-product as elsewhere). Rather than add a
// redundant section, configure it to the spec: heading "Vous aimerez aussi", max 4 products.
// Sold-out filtering is moot under dropship (inventory_management: null → always available).
// Config lives in templates/product.json (the section's settings), not main-product.liquid.
import { rest, sleep, LIVE_THEME_ID } from "./_shopify-lib.mjs";
const T = "160213696617";
if (T === LIVE_THEME_ID) throw new Error("refusing to run against the LIVE theme");
const get = async (k) => (await (await rest(`/themes/${T}/assets.json?asset[key]=${encodeURIComponent(k)}`)).json()).asset.value;
async function put(k, v) {
  const r = await rest(`/themes/${T}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key: k, value: v } }) });
  if (!r.ok) throw new Error(`put ${k}: ${r.status} ${await r.text()}`);
  await sleep(550);
  return r.status;
}

const pj = JSON.parse(await get("templates/product.json"));
const rp = pj.sections["related-products"];
if (!rp) throw new Error("related-products section absent in product.json");
const before = { heading: rp.settings.heading, n: rp.settings.products_to_show, cols: rp.settings.columns_desktop };
rp.settings.heading = "Vous aimerez aussi";
rp.settings.products_to_show = 4;
rp.settings.columns_desktop = 4;
JSON.parse(JSON.stringify(pj));
const status = await put("templates/product.json", JSON.stringify(pj, null, 2));
console.log(`✔ related-products: heading "${before.heading}" → "Vous aimerez aussi", products ${before.n}→4, cols ${before.cols}→4`);
console.log(`PUT templates/product.json → HTTP ${status}`);
console.log("Note: uses Shopify related-recommendations (category-aware) + card-product; sold-out moot under dropship. EN heading = theme-translation follow-up.");
