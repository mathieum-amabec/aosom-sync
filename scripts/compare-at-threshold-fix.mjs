// Gate the compare-at strikethrough + Sale badges on discount >= 10% (matching the existing
// "Économisez/Save" rule), on snippets/price.liquid + snippets/card-product.liquid.
// DRAFT theme 160656818281 ONLY, role-gated. Dry-run writes /tmp originals+modified for diffing.
// --apply PUTs to the draft + verifies.
//   node scripts/compare-at-threshold-fix.mjs [--apply]
import { writeFileSync, readFileSync } from "node:fs";
const env = (() => { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const e = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); e[m[1]] = v; } return e; })();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL no token"); process.exit(2); }
const DRAFT = "160656818281", LIVE = "160606093417";
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method, path, body) => fetch(`https://${STORE}/admin/api/${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
function must(cond, msg) { if (!cond) { console.error("ASSERT FAIL: " + msg); process.exit(1); } }
function replaceOnce(src, find, repl, label) { const i = src.indexOf(find); must(i !== -1, `anchor not found: ${label}`); must(src.indexOf(find, i + 1) === -1, `anchor NOT unique: ${label}`); return src.slice(0, i) + repl + src.slice(i + find.length); }

// ---- gate ----
const themes = (await (await api("GET", "/themes.json")).json()).themes;
const d = themes.find((t) => String(t.id) === DRAFT), l = themes.find((t) => String(t.id) === LIVE);
must(d && d.role !== "main", `draft ${DRAFT} must be non-main`);
must(l && l.role === "main", `live ${LIVE} must be main`);
console.log(`Gate OK — draft "${d.name}" [${d.role}], live [${l.role}]`);
console.log(APPLY ? "\n*** APPLY to DRAFT ***\n" : "\n--- DRY RUN ---\n");

async function getAsset(key) { const r = await api("GET", `/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(key)}`); must(r.ok, `get ${key}`); return (await r.json()).asset.value; }

// ============ price.liquid ============
let price = await getAsset("snippets/price.liquid");
const priceOrig = price;
// idempotency
if (price.includes("lc_show_strike")) { console.log("price.liquid: already patched (lc_show_strike present) — skip"); }
else {
  // 1) insert compute block before the price div
  price = replaceOnce(price,
    `  <div\n    class="\n      price`,
    `  {%- liquid\n    assign lc_disc_pct = 0\n    if compare_at_price > price\n      assign lc_disc_pct = compare_at_price | minus: price | times: 100 | divided_by: compare_at_price\n    endif\n    assign lc_show_strike = false\n    if compare_at_price > price and lc_disc_pct >= 10\n      assign lc_show_strike = true\n    endif\n  -%}\n  <div\n    class="\n      price`,
    "insert compute block");
  // 2) line 49 strikethrough class
  price = replaceOnce(price,
    `{%- if compare_at_price > price and product.quantity_price_breaks_configured? != true %} price--on-sale{% endif -%}`,
    `{%- if lc_show_strike and product.quantity_price_breaks_configured? != true %} price--on-sale{% endif -%}`,
    "line49 on-sale class");
  // 3) line 50 volume sale-badge class
  price = replaceOnce(price,
    `{%- if compare_at_price > price and product.quantity_price_breaks_configured? %} volume-pricing--sale-badge{% endif -%}`,
    `{%- if lc_show_strike and product.quantity_price_breaks_configured? %} volume-pricing--sale-badge{% endif -%}`,
    "line50 volume class");
  // 4) wrap .price__sale strikethrough (open)
  price = replaceOnce(price,
    `<div class="price__sale">\n        {%- unless product.price_varies == false and product.compare_at_price_varies %}`,
    `<div class="price__sale">\n        {%- if lc_show_strike -%}\n        {%- unless product.price_varies == false and product.compare_at_price_varies %}`,
    "price__sale wrap open");
  // 4b) wrap .price__sale strikethrough (close) — target the endunless immediately before the sale_price span
  price = replaceOnce(price,
    `        {%- endunless -%}\n        <span class="visually-hidden visually-hidden--inline">{{ 'products.product.price.sale_price' | t }}</span>`,
    `        {%- endunless -%}\n        {%- endif -%}\n        <span class="visually-hidden visually-hidden--inline">{{ 'products.product.price.sale_price' | t }}</span>`,
    "price__sale wrap close");
  // 5) gate the product-page sale badge (price__badge-sale) too — full consistency
  price = replaceOnce(price,
    `      <span class="badge price__badge-sale color-{{ settings.sale_badge_color_scheme }}">\n        {{ 'products.product.on_sale' | t }}\n      </span>`,
    `      {%- if lc_show_strike -%}\n      <span class="badge price__badge-sale color-{{ settings.sale_badge_color_scheme }}">\n        {{ 'products.product.on_sale' | t }}\n      </span>\n      {%- endif -%}`,
    "price__badge-sale gate");
}

// ============ card-product.liquid ============
let card = await getAsset("snippets/card-product.liquid");
const cardOrig = card;
if (card.includes("lc_card_disc_pct")) { console.log("card-product.liquid: already patched — skip"); }
else {
  // prepend compute block
  card = `{%- liquid\n  assign lc_card_disc_pct = 0\n  if card_product.compare_at_price > card_product.price\n    assign lc_card_disc_pct = card_product.compare_at_price | minus: card_product.price | times: 100 | divided_by: card_product.compare_at_price\n  endif\n-%}\n` + card;
  // gate BOTH badge conditions (identical string, appears twice)
  const badgeFind = `{%- elsif card_product.compare_at_price > card_product.price and card_product.available -%}`;
  const count = card.split(badgeFind).length - 1;
  must(count === 2, `expected 2 card badge conditions, found ${count}`);
  card = card.split(badgeFind).join(`{%- elsif card_product.compare_at_price > card_product.price and card_product.available and lc_card_disc_pct >= 10 -%}`);
}

// write files for diff
writeFileSync("C:/Users/vente/AppData/Local/Temp/price.liquid.orig", priceOrig); writeFileSync("C:/Users/vente/AppData/Local/Temp/price.liquid.new", price);
writeFileSync("C:/Users/vente/AppData/Local/Temp/card-product.liquid.orig", cardOrig); writeFileSync("C:/Users/vente/AppData/Local/Temp/card-product.liquid.new", card);
console.log("wrote /tmp/{price,card-product}.liquid.{orig,new} for diffing");

if (!APPLY) { console.log("\nDRY-RUN — no upload. Review the diff."); process.exit(0); }

// ---- apply ----
for (const [key, val] of [["snippets/price.liquid", price], ["snippets/card-product.liquid", card]]) {
  const put = await api("PUT", `/themes/${DRAFT}/assets.json`, { asset: { key, value: val } });
  must(put.status === 200, `PUT ${key} -> ${put.status} ${await put.text()}`);
  console.log(`  PUT ${key} -> 200`);
  await sleep(500);
}
// verify both contain the gate
let ok = true;
for (const key of ["snippets/price.liquid", "snippets/card-product.liquid"]) {
  for (let a = 0; a < 5; a++) { const v = await getAsset(key); if (/lc_(show_strike|card_disc_pct)/.test(v)) { console.log(`  ${key}: verified`); break; } if (a === 4) { ok = false; console.error(`  ${key}: NOT verified`); } await sleep(2000); }
}
process.exit(ok ? 0 : 1);
