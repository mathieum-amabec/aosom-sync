// Phase 4 — PDP redesign on PREVIEW 160213696617 (live untouched; guarded).
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");
console.log(`Target: ${t.id} "${t.name}" [${t.role}]`);
const SVG = (inner, sz = 20) => `<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="#1B2A4A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">${inner}</svg>`;
const TRUCK = SVG('<path d="M1 4h13v11H1z"/><path d="M14 7h4l3 3v5h-7z"/><circle cx="5.5" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>');
const RETURN = SVG('<path d="M3 8V3"/><path d="M3 8h5"/><path d="M3.6 8a9 9 0 1 1-1.1 6.4"/>');
const LOCK = SVG('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');
const LEAF = SVG('<path d="M11 21c5-1 9-6 9-13V4h-4C9 4 4 9 4 16c0 2 1 4 1 4"/><path d="M5 20c3-6 7-9 12-10"/>');

// ---- 1. main-product.liquid: eyebrow + judge badge under H1, + ATC navy style ----
let mp = await getAsset("sections/main-product.liquid", PREVIEW);
const TITLE_OLD = `              {%- when 'title' -%}
                <div class="product__title" {{ block.shopify_attributes }}>
                  <h1>{{ lc_product_title | escape }}</h1>
                </div>`;
const TITLE_NEW = `              {%- when 'title' -%}
                <div class="product__title" {{ block.shopify_attributes }}>
                  {%- if product.type != blank -%}<p class="product-eyebrow" style="font-family:'DM Sans',sans-serif;font-size:1.15rem;letter-spacing:.12em;text-transform:uppercase;color:#1B2A4A;font-weight:600;margin:0 0 .4rem">{{ product.type | escape }}</p>{%- endif -%}
                  <h1>{{ lc_product_title | escape }}</h1>
                  <a href="#judgeme_product_reviews" class="jdgm-prev-badge-link" style="display:inline-block;margin-top:.5rem;text-decoration:none"><div class="jdgm-widget jdgm-preview-badge" data-id="{{ product.id }}">{{ product.metafields.judgeme.badge }}</div></a>
                </div>`;
if (mp.includes("product-eyebrow")) console.log("1a. eyebrow already present");
else { if (!mp.includes(TITLE_OLD)) throw new Error("ABORT: title block not found verbatim"); mp = mp.replace(TITLE_OLD, TITLE_NEW); console.log("1a. eyebrow + judge badge added under H1"); }

const BB_OLD = `              {%- when 'buy_buttons' -%}
                {%- render 'buy-buttons',`;
const ATC_STYLE = `<style>.product-form__submit{background:#1B2A4A!important;color:#fff!important;border:1px solid #1B2A4A!important;border-radius:4px!important;font-weight:700}.product-form__submit:hover{background:#2a3f6b!important;border-color:#2a3f6b!important}.product-form__submit>*{color:#fff!important}@media(max-width:749px){.product-form__submit{width:100%!important}}</style>`;
const BB_NEW = `              {%- when 'buy_buttons' -%}
                ${ATC_STYLE}
                {%- render 'buy-buttons',`;
if (mp.includes("product-form__submit{background:#1B2A4A")) console.log("1b. ATC style already present");
else { if (!mp.includes(BB_OLD)) throw new Error("ABORT: buy_buttons case not found verbatim"); mp = mp.replace(BB_OLD, BB_NEW); console.log("1b. ATC navy style added"); }
await putAsset("sections/main-product.liquid", mp, PREVIEW);
console.log("main-product.liquid PUT 200");

// ---- 2. price.liquid: "Économisez X$" only if discount >= 10% ----
let pr = await getAsset("snippets/price.liquid", PREVIEW);
const PR_OLD = `    {%- if show_badges -%}
      <span class="badge price__badge-sale color-{{ settings.sale_badge_color_scheme }}">`;
const SAVE = `    {%- if compare_at_price > price -%}
      {%- assign disc_pct = compare_at_price | minus: price | times: 100 | divided_by: compare_at_price -%}
      {%- if disc_pct >= 10 -%}
        {%- assign lc_savings = compare_at_price | minus: price -%}
        <span class="price-save" style="display:inline-block;margin-top:.4rem;font-size:1.3rem;font-weight:700;color:#1B7A3D">{% if request.locale.iso_code == 'en' %}Save {{ lc_savings | money }}{% else %}Économisez {{ lc_savings | money }}{% endif %}</span>
      {%- endif -%}
    {%- endif -%}
    {%- if show_badges -%}
      <span class="badge price__badge-sale color-{{ settings.sale_badge_color_scheme }}">`;
if (pr.includes("price-save")) console.log("2. price-save already present");
else { if (!pr.includes(PR_OLD)) throw new Error("ABORT: price show_badges anchor not found"); pr = pr.replace(PR_OLD, SAVE); await putAsset("snippets/price.liquid", pr, PREVIEW); console.log("2. price.liquid PUT 200 (Économisez >=10%)"); }

// ---- 3. product.json trust_badges: emoji -> SVG navy ----
const pj = JSON.parse(await getAsset("templates/product.json", PREVIEW));
const badge = (svg, fr, en) => `  <div style="background:#FAFAF8;border:1px solid rgba(26,26,46,.08);border-radius:8px;padding:10px 12px;font-size:1.3rem;display:flex;align-items:center;gap:.5rem;color:#1A1A2E">${svg}<span>{% if loc == 'en' %}${en}{% else %}${fr}{% endif %}</span></div>`;
pj.sections.main.blocks.trust_badges.settings.custom_liquid =
  `{%- assign loc = request.locale.iso_code | downcase -%}<div style="margin-top:1.5rem;display:grid;grid-template-columns:1fr 1fr;gap:.7rem">\n` +
  badge(TRUCK, "Livraison gratuite Canada", "Free shipping Canada") + "\n" +
  badge(RETURN, "Retours 30 jours", "30-day returns") + "\n" +
  badge(LOCK, "Paiement sécurisé", "Secure payment") + "\n" +
  badge(LEAF, "Service québécois", "Canadian service") + "\n</div>";
await putAsset("templates/product.json", JSON.stringify(pj, null, 2), PREVIEW);
console.log("3. product.json trust_badges PUT 200 (emoji -> SVG navy)");
