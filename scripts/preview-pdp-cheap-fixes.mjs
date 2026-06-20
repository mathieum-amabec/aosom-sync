// Chantier 2 (Phase 1) — anti-cheap PDP/home fixes, PREVIEW THEME ONLY.
//
// Target theme: 160213696617 "Copie de Copie de Trade v2" (UNPUBLISHED).
// NEVER the live theme 160059195497.
//
// Idempotent: each edit checks whether it is already applied before PUTting.
// Validates JSON assets parse before and after.
//
// Fixes:
//   1. Duplicate PDP title  -> single <h1> (remove redundant <h2 class="h1"> link)
//   3. Verbose quantity aria-labels -> sober ("Réduire/Augmenter la quantité")
//   4. Emoji reassurance badges -> thin-line navy (#1B2A4A) inline SVG icons
//      (why_us multicolumn -> custom-liquid SVG row; announcement bar emojis stripped)
//   5. Sold-out products excluded from featured-collection carousels (where available)
//
// Note: fix #2 (literal "##" in descriptions) is intentionally NOT applied — a full
// scan found 0/502 descriptions contain "##"; nothing to strip. See DATA-OPS-LOG.
//
// Run:  node scripts/preview-pdp-cheap-fixes.mjs
import { rest, sleep, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const THEME = "160213696617"; // PREVIEW — hard-coded so we never touch live
if (THEME === LIVE_THEME_ID) throw new Error("refusing to run against the LIVE theme");

async function getAsset(key) {
  const res = await rest(`/themes/${THEME}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`get ${key}: ${res.status} ${await res.text()}`);
  return (await res.json()).asset.value;
}
async function putAsset(key, value) {
  const res = await rest(`/themes/${THEME}/assets.json`, {
    method: "PUT", body: JSON.stringify({ asset: { key, value } }),
  });
  if (!res.ok) throw new Error(`put ${key}: ${res.status} ${await res.text()}`);
  await sleep(550);
}
const log = (...a) => console.log(...a);

// ── thin-line navy SVG icon set (stroke #1B2A4A) ──────────────────────────────
const ICO = {
  truck: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h13v11H1z"/><path d="M14 7h4l3 3v5h-7z"/><circle cx="5.5" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l8 3v5.5c0 5-3.4 8-8 9.5-4.6-1.5-8-4.5-8-9.5V5.5z"/><path d="M8.5 12l2.4 2.4L15.5 9.6"/></svg>`,
  ret: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V3"/><path d="M3 8h5"/><path d="M3.6 8a9 9 0 1 1-1.1 6.4"/></svg>`,
  headset: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13.5" width="3.6" height="6.5" rx="1.4"/><rect x="17.9" y="13.5" width="3.6" height="6.5" rx="1.4"/><path d="M20 20a4 4 0 0 1-4 3h-2"/></svg>`,
};

const COLS = [
  { ico: ICO.truck, title: "Livraison gratuite", text: "Partout au Canada, sans frais" },
  { ico: ICO.shield, title: "Qualité garantie", text: "Produits sélectionnés avec soin" },
  { ico: ICO.ret, title: "Retours faciles", text: "30 jours pour changer d'avis" },
  { ico: ICO.headset, title: "Support québécois", text: "Une équipe humaine, locale" },
];
const whyUsLiquid =
  `<div class="page-width lc-why" style="padding:8px 0">` +
  `<div class="lc-why-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px;text-align:center">` +
  COLS.map((c) =>
    `<div class="lc-why-col">` +
    `<div class="lc-why-ico" style="height:40px;display:flex;align-items:center;justify-content:center;margin-bottom:.6rem">${c.ico}</div>` +
    `<h3 style="font-size:1.5rem;margin:0 0 .25rem;color:#1A1A2E">${c.title}</h3>` +
    `<p style="font-size:1.3rem;margin:0;color:#797068">${c.text}</p></div>`
  ).join("") +
  `</div></div>` +
  `<style>.lc-why-ico svg{display:block}@media(max-width:749px){.lc-why-grid{grid-template-columns:repeat(2,1fr);gap:20px}}</style>`;

let changed = 0, skipped = 0;

// ── Fix 1: duplicate PDP title ────────────────────────────────────────────────
{
  const key = "sections/main-product.liquid";
  let v = await getAsset(key);
  const dupRe = /\s*<a href="\{\{ product\.url \}\}" class="product__title">\s*<h2 class="h1">\s*\{\{ lc_product_title \| escape \}\}\s*<\/h2>\s*<\/a>/;
  if (dupRe.test(v)) {
    v = v.replace(dupRe, "");
    await putAsset(key, v);
    log("✔ fix1 main-product.liquid: removed redundant <h2> title link"); changed++;
  } else { log("• fix1 already applied (no redundant <h2> title)"); skipped++; }
}

// ── Fix 3: sober quantity labels (locale root cause) ──────────────────────────
{
  const key = "locales/fr.json";
  let v = await getAsset(key);
  JSON.parse(v); // validate before
  const before = v;
  v = v.replace(/"increase":\s*"Augmenter la quantité de \{\{ product \}\}"/, '"increase": "Augmenter la quantité"');
  v = v.replace(/"decrease":\s*"Réduire la quantité de \{\{ product \}\}"/, '"decrease": "Réduire la quantité"');
  if (v !== before) {
    JSON.parse(v); // validate after
    await putAsset(key, v);
    log("✔ fix3 locales/fr.json: quantity labels shortened"); changed++;
  } else { log("• fix3 already applied (quantity labels already sober)"); skipped++; }
}

// ── Fix 4a: why_us multicolumn -> custom-liquid SVG row ───────────────────────
{
  const key = "templates/index.json";
  let v = await getAsset(key);
  const json = JSON.parse(v);
  const sec = json.sections?.why_us;
  if (sec && sec.type === "multicolumn") {
    json.sections.why_us = {
      type: "custom-liquid",
      settings: {
        custom_liquid: whyUsLiquid,
        color_scheme: sec.settings?.color_scheme || "scheme-3",
        padding_top: 36,
        padding_bottom: 36,
      },
    };
    const out = JSON.stringify(json, null, 2);
    JSON.parse(out);
    await putAsset(key, out);
    log("✔ fix4a templates/index.json: why_us -> SVG reassurance row"); changed++;
  } else { log("• fix4a already applied (why_us not a multicolumn)"); skipped++; }
}

// ── Fix 4b: strip emojis from announcement bar ────────────────────────────────
{
  const key = "sections/header-group.json";
  let v = await getAsset(key);
  const json = JSON.parse(v);
  const blocks = json.sections?.["announcement-bar"]?.blocks || {};
  let touched = false;
  const stripEmoji = (s) => s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}]/gu, "")
    .replace(/\s{2,}/g, " ").replace(/^\s*\|\s*/, "").trim();
  for (const b of Object.values(blocks)) {
    if (b?.settings?.text) {
      const cleaned = stripEmoji(b.settings.text);
      if (cleaned !== b.settings.text) { b.settings.text = cleaned; touched = true; }
    }
  }
  if (touched) {
    const out = JSON.stringify(json, null, 2);
    JSON.parse(out);
    await putAsset(key, out);
    log("✔ fix4b header-group.json: announcement-bar emojis stripped"); changed++;
  } else { log("• fix4b already applied (no emojis in announcement bar)"); skipped++; }
}

// ── Fix 5: exclude sold-out products from featured-collection carousels ────────
{
  const key = "sections/featured-collection.liquid";
  let v = await getAsset(key);
  if (!v.includes("cc_available_products")) {
    // Inject a filtered assign and repoint the three references to it.
    v = v.replace(
      "{%- if section.settings.collection.products.size > 0 -%}",
      "{%- assign cc_available_products = section.settings.collection.products | where: 'available', true -%}\n        {%- if cc_available_products.size > 0 -%}"
    );
    v = v.replace(
      "{% paginate section.settings.collection.products by section.settings.products_to_show %}",
      "{% paginate cc_available_products by section.settings.products_to_show %}"
    );
    v = v.replace(
      "{%- for product in section.settings.collection.products limit: section.settings.products_to_show -%}",
      "{%- for product in cc_available_products limit: section.settings.products_to_show -%}"
    );
    if (!v.includes("cc_available_products")) throw new Error("fix5 anchors not found");
    await putAsset(key, v);
    log("✔ fix5 featured-collection.liquid: sold-out products excluded (where available)"); changed++;
  } else { log("• fix5 already applied (cc_available_products present)"); skipped++; }
}

log(`\nDone on PREVIEW theme ${THEME}. ${changed} change(s), ${skipped} already-applied.`);
log("Preview: https://27u5y2-kp.myshopify.com/?preview_theme_id=" + THEME);
