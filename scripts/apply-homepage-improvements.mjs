// CHANTIER 1+2 on PREVIEW theme 160213696617. HARD GUARD: preview-only.
//  C1: remove the fabricated testimonials multicolumn (multicolumn_eWXcry).
//  C2a: remove the redundant 3rd carousel featured_collection1 (Mobilier extérieur,
//       93% overlap with Coups de cœur).
//  C2b: cut "livraison gratuite" repetition (keep lc_hero + lc_trustbar; why_us icon left).
import { rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const LIVE = LIVE_THEME_ID;
const PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT: preview equals live");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not an unpublished preview");
console.log(`Target preview: ${t.id} "${t.name}" [${t.role}]`);

const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));

// --- C1: remove fabricated testimonials ---
if (idx.sections.multicolumn_eWXcry) {
  delete idx.sections.multicolumn_eWXcry;
  idx.order = idx.order.filter((k) => k !== "multicolumn_eWXcry");
  console.log("C1: removed multicolumn_eWXcry (fabricated testimonials) + order entry");
} else console.log("C1: multicolumn_eWXcry already absent");

// --- C2a: remove redundant 3rd carousel ---
if (idx.sections.featured_collection1) {
  delete idx.sections.featured_collection1;
  idx.order = idx.order.filter((k) => k !== "featured_collection1");
  console.log("C2a: removed featured_collection1 (Mobilier extérieur, 93% overlap) + order entry");
} else console.log("C2a: featured_collection1 already absent");

// --- C2b: cut "livraison gratuite" repetition ---
function patch(sectionId, pairs) {
  const block = idx.sections[sectionId]?.settings;
  if (!block || typeof block.custom_liquid !== "string") throw new Error(`ABORT: ${sectionId} custom_liquid missing`);
  for (const [oldS, newS] of pairs) {
    if (block.custom_liquid.includes(newS) && !block.custom_liquid.includes(oldS)) { console.log(`  = ${sectionId}: already patched`); continue; }
    if (!block.custom_liquid.includes(oldS)) throw new Error(`ABORT: not found in ${sectionId}: ${oldS.slice(0, 50)}`);
    block.custom_liquid = block.custom_liquid.split(oldS).join(newS);
    console.log(`  + ${sectionId}: removed "${oldS.slice(0, 45)}..."`);
  }
}
patch("lc_story2", [
  ["Patios, jardins, BBQ : tout pour profiter du plein air québécois. Livraison gratuite, même sur les gros ensembles.", "Patios, jardins, BBQ : tout pour profiter du plein air québécois."],
  ["Patios, gardens, BBQ: everything to enjoy the outdoors. Free shipping, even on large sets.", "Patios, gardens, BBQ: everything to enjoy the outdoors."],
]);
patch("lc_trust", [
  ["Livraison gratuite · Retours faciles · Service québécois", "Retours faciles · Service québécois"],
  ["Free shipping · Easy returns · Canadian service", "Easy returns · Canadian service"],
]);
patch("lc_howit", [
  ["{% if loc == 'en' %}Free shipping{% else %}Livraison gratuite{% endif %}", "{% if loc == 'en' %}Home delivery{% else %}Livraison à domicile{% endif %}"],
]);
patch("shop_pay_home", [
  ["✓ Livraison gratuite · ✓ Retours 30j · ✓ Paiement sécurisé", "✓ Retours 30j · ✓ Paiement sécurisé"],
  ["✓ Free shipping · ✓ 30-day returns · ✓ Secure payment", "✓ 30-day returns · ✓ Secure payment"],
]);
// rich_text block text
const rt = idx.sections.rich_text;
let rtDone = false;
for (const b of Object.values(rt.blocks || {})) {
  if (b.settings?.text && b.settings.text.includes("LIVRAISON GRATUITE | ")) {
    b.settings.text = b.settings.text.replace("LIVRAISON GRATUITE | ", "");
    rtDone = true;
    console.log("  + rich_text: removed 'LIVRAISON GRATUITE | '");
  }
}
if (!rtDone) console.log("  = rich_text: already patched or not found");

await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW);
console.log("\nindex.json PUT 200. New order:", idx.order.join(", "));
