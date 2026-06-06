// FIX 1-3 — homepage polish on preview copy theme 160059195497.
// Reads templates/index.json, mutates sections in node, writes back.
// Backs up the original to scripts/reports/ for reversibility.
import { getAsset, putAsset, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");

const raw = await getAsset("templates/index.json");
const idx = JSON.parse(raw);

// --- backup original ---
const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });
const backupPath = join(reportsDir, `index.json.backup-${PREVIEW_THEME_ID}.json`);
writeFileSync(backupPath, raw, "utf8");
console.log(`Backup written: ${backupPath}\n`);

// ============ FIX 1 — Hero: text to top + top overlay ============
const heroLiquid =
  `{%- assign loc = request.locale.iso_code | downcase -%}` +
  `<div style="position:relative;background:url('{{ 'lc-hero.jpg' | asset_url }}') center/cover no-repeat;min-height:460px;display:flex;align-items:flex-start">\n` +
  `  <div class="lc-hero-ov" style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.6) 0%,rgba(0,0,0,.18) 45%,transparent 72%),linear-gradient(to right,rgba(0,0,0,.5) 0%,rgba(0,0,0,.2) 65%,transparent 100%)"></div>\n` +
  `  <div class="page-width lc-hero-in" style="position:relative;color:#fff;max-width:640px">\n` +
  `    <h1 style="font-size:clamp(2.4rem,5vw,4.4rem);line-height:1.1;margin:0 0 1rem">{% if loc == 'en' %}Furnish your space.<br class="lc-hero-br">Free shipping across Canada.{% else %}Meublez votre espace.<br class="lc-hero-br">Livraison gratuite au Canada.{% endif %}</h1>\n` +
  `    <p style="font-size:1.7rem;margin:0 0 2rem">{% if loc == 'en' %}500+ products · Furniture, outdoor, pets{% else %}Plus de 500 produits · Meubles, extérieur, animaux{% endif %}</p>\n` +
  `    <a href="/collections/all" class="lc-btn" style="display:inline-block;background:#C17F3E;color:#fff;padding:14px 28px;border-radius:6px;font-weight:700;text-decoration:none;font-size:1.5rem">{% if loc == 'en' %}Shop now{% else %}Magasinez maintenant{% endif %}</a>\n` +
  `  </div>\n` +
  `</div>\n` +
  `<style>.lc-hero-in{padding:10% 0 48px}.lc-hero-br{display:none}@media(max-width:749px){.lc-hero-in{text-align:center;margin:0 auto;padding:15% 0 40px}.lc-hero-in h1{font-size:clamp(1.8rem,6vw,2.5rem)!important}.lc-hero-br{display:inline}.lc-hero-ov{background:linear-gradient(to bottom,rgba(0,0,0,.78) 0%,rgba(0,0,0,.35) 50%,transparent 82%)!important}}</style>`;
idx.sections.lc_hero.settings.custom_liquid = heroLiquid;
console.log("FIX 1 ✓ lc_hero: align-items flex-start, padding-top 10%/15%, top gradient overlay");

// ============ FIX 2 — why_us: kill default "Texte du bouton" ============
const beforeBtn = idx.sections.why_us.settings.button_label;
idx.sections.why_us.settings.button_label = "";
idx.sections.why_us.settings.button_link = "";
console.log(`FIX 2 ✓ why_us.button_label: ${JSON.stringify(beforeBtn)} -> "" (was falling back to Dawn default)`);

// ============ FIX 3 — carousels: 16 products + desktop slider ============
for (const id of ["featured_collection1", "featured_collection2"]) {
  const s = idx.sections[id].settings;
  const before = { products_to_show: s.products_to_show, slider: s.enable_desktop_slider };
  s.products_to_show = 16;
  s.enable_desktop_slider = true;
  console.log(`FIX 3 ✓ ${id} (${s.title}): products_to_show ${before.products_to_show}->16, desktop_slider ${before.slider}->true`);
}
console.log("FIX 3 NOTE: Dawn's native slider has NO infinite loop — `loop:true` is not a Dawn capability. Swipe carousel enabled instead.");

// --- write back ---
const out = JSON.stringify(idx, null, 2);
if (DRY) {
  console.log("\n[DRY RUN] index.json NOT written. Bytes that would be written:", out.length);
} else {
  await putAsset("templates/index.json", out);
  console.log("\nindex.json written to theme " + PREVIEW_THEME_ID);
}
