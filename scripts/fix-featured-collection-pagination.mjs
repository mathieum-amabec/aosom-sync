// P0 fix on PREVIEW theme 160213696617: the `where: 'available'` array is not
// paginateable. Restore pagination over collection.products and move the availability
// check INSIDE the loop. HARD GUARD: preview-only.
import { rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const LIVE = LIVE_THEME_ID;
const PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT: preview equals live");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error(`ABORT: theme ${PREVIEW} not an unpublished preview`);
console.log(`Target preview: ${t.id} "${t.name}" [${t.role}]`);

// Scan all preview assets for the broken token (to catch any other affected section file).
const assets = (await (await rest(`/themes/${PREVIEW}/assets.json`)).json()).assets;
const candidates = [];
for (const a of assets) {
  if (!/\.liquid$/.test(a.key)) continue;
  let v;
  try { v = await getAsset(a.key, PREVIEW); } catch { continue; }
  if (v.includes("cc_available_products")) candidates.push(a.key);
}
console.log("assets containing cc_available_products:", candidates.join(", ") || "(none)");

const HEADER_OLD = `        {%- assign cc_available_products = section.settings.collection.products | where: 'available', true -%}
        {%- if cc_available_products.size > 0 -%}
          {% assign lazy_load = false %}
          {% paginate cc_available_products by section.settings.products_to_show %}
            {%- for product in cc_available_products limit: section.settings.products_to_show -%}`;
const HEADER_NEW = `        {%- if section.settings.collection.products.size > 0 -%}
          {% assign lazy_load = false %}
          {% paginate section.settings.collection.products by section.settings.products_to_show %}
            {%- for product in section.settings.collection.products limit: section.settings.products_to_show -%}
              {%- if product.available -%}`;
const ENDFOR_OLD = `              {%- assign skip_card_product_styles = true -%}
            {%- endfor -%}`;
const ENDFOR_NEW = `              {%- assign skip_card_product_styles = true -%}
              {%- endif -%}
            {%- endfor -%}`;

for (const key of candidates) {
  let s = await getAsset(key, PREVIEW);
  if (!s.includes("cc_available_products")) { console.log(`${key}: already clean — skip`); continue; }
  if (!s.includes(HEADER_OLD)) throw new Error(`ABORT: header block not found verbatim in ${key}`);
  if (!s.includes(ENDFOR_OLD)) throw new Error(`ABORT: endfor block not found verbatim in ${key}`);
  s = s.replace(HEADER_OLD, HEADER_NEW).replace(ENDFOR_OLD, ENDFOR_NEW);
  if (s.includes("cc_available_products")) throw new Error(`ABORT: ${key} still has cc_available_products after replace`);
  await putAsset(key, s, PREVIEW);
  console.log(`${key}: PUT 200 (paginate collection.products + in-loop product.available)`);
}

// Verify
console.log("\n=== verify ===");
for (const key of candidates) {
  const s = await getAsset(key, PREVIEW);
  console.log(`${key}: cc_available_products present=${s.includes("cc_available_products")} | paginate collection.products=${s.includes("paginate section.settings.collection.products by")} | in-loop available=${s.includes("{%- if product.available -%}")}`);
}
