// FIX 1 (hero desktop space), FIX 3 (Sale section), FIX 2+4 (loop injector + hide counter)
// on preview copy theme 160059195497.
import { getAsset, putAsset, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");

const raw = await getAsset("templates/index.json");
const idx = JSON.parse(raw);

const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, `index.json.backup2-${PREVIEW_THEME_ID}.json`), raw, "utf8");

// ===== FIX 1 — hero: space before the hidden-on-desktop <br> =====
const hero = idx.sections.lc_hero.settings.custom_liquid;
const heroFixed = hero.split('.<br class="lc-hero-br">').join('. <br class="lc-hero-br">');
idx.sections.lc_hero.settings.custom_liquid = heroFixed;
const heroChanged = heroFixed !== hero;
console.log(`FIX 1 ${heroChanged ? "✓" : "× (no match)"} hero: added space before .lc-hero-br (desktop now reads "X. Y")`);

// ===== FIX 3 — Sale featured-collection section =====
idx.sections.featured_sale = {
  type: "featured-collection",
  settings: {
    collection: "rabais",
    products_to_show: 12,
    title: "🔥 Meilleures offres du moment",
    heading_size: "h2",
    description: "",
    show_description: false,
    description_style: "body",
    columns_desktop: 4,
    enable_desktop_slider: true,
    full_width: false,
    show_view_all: true,
    view_all_style: "solid",
    color_scheme: "",
    image_ratio: "adapt",
    image_shape: "default",
    show_secondary_image: true,
    show_vendor: false,
    show_rating: false,
    quick_add: "bulk",
    columns_mobile: "2",
    swipe_on_mobile: true,
    padding_top: 36,
    padding_bottom: 40,
  },
};
// position: right after lc_trustbar (hero + trust bar), before storytelling
let order = idx.order.filter((id) => id !== "featured_sale" && id !== "lc_loop");
const trustIdx = order.indexOf("lc_trustbar");
const insertAt = trustIdx >= 0 ? trustIdx + 1 : 1;
order.splice(insertAt, 0, "featured_sale");
console.log(`FIX 3 ✓ featured_sale inserted at position ${insertAt} (after lc_trustbar)`);

// ===== FIX 2 + 4 — loop injector (custom-liquid) appended last =====
const loopLiquid =
  `<style>` +
  `#shopify-section-featured_collection1 .slider-counter,` +
  `#shopify-section-featured_collection2 .slider-counter,` +
  `#shopify-section-featured_sale .slider-counter{display:none!important}` +
  `</style>` +
  `<script>(function(){` +
  `function setup(ul){if(!ul||ul.dataset.loopInit)return;` +
  `var items=Array.prototype.slice.call(ul.children);if(items.length<2)return;` +
  `ul.dataset.loopInit='1';var n=items.length;` +
  `items.forEach(function(li){var c=li.cloneNode(true);c.setAttribute('aria-hidden','true');c.setAttribute('data-loop-clone','1');` +
  `c.querySelectorAll('[id]').forEach(function(e){e.removeAttribute('id');});ul.appendChild(c);});` +
  `function span(){return ul.children[n].offsetLeft-ul.children[0].offsetLeft;}` +
  `var jumping=false;` +
  `ul.addEventListener('scroll',function(){if(jumping)return;var s=span();if(s>0&&ul.scrollLeft>=s){jumping=true;ul.scrollLeft-=s;jumping=false;}},{passive:true});}` +
  `function init(){['featured_collection1','featured_collection2','featured_sale'].forEach(function(id){` +
  `var sec=document.getElementById('shopify-section-'+id);if(!sec)return;` +
  `var ul=sec.querySelector('ul.slider')||sec.querySelector('.slider');if(ul)setup(ul);});}` +
  `if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);` +
  `})();</script>`;
idx.sections.lc_loop = { type: "custom-liquid", settings: { custom_liquid: loopLiquid, padding_top: 0, padding_bottom: 0 } };
order.push("lc_loop");
idx.order = order;
console.log(`FIX 2 ✓ lc_loop injector appended (clone+wrap on featured_collection1/2 + featured_sale)`);
console.log(`FIX 4 ✓ slider-counter hidden on the 3 homepage carousels`);

console.log("\nNew order:", order.join(" > "));

const out = JSON.stringify(idx, null, 2);
if (DRY) {
  console.log(`\n[DRY] not written (${out.length} bytes)`);
} else {
  await putAsset("templates/index.json", out);
  console.log(`\nindex.json written to theme ${PREVIEW_THEME_ID}`);
}
