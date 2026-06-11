// CHANTIER 1 — reduce "livraison gratuite" to 2 home mentions (PREVIEW only).
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");
console.log(`Target: ${t.id} "${t.name}" [${t.role}]`);

const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));

function patch(id, oldS, newS) {
  const b = idx.sections[id].settings;
  if (b.custom_liquid.includes(newS) && !b.custom_liquid.includes(oldS)) { console.log(`= ${id}: already`); return; }
  if (!b.custom_liquid.includes(oldS)) throw new Error(`ABORT: not found in ${id}: ${oldS.slice(0, 40)}`);
  b.custom_liquid = b.custom_liquid.split(oldS).join(newS);
  console.log(`+ ${id}: patched`);
}

// hero H1 second line (FR + EN)
patch("lc_hero", "Meublez votre espace. <br class=\"lc-hero-br\">Livraison gratuite au Canada.", "Meublez votre espace. <br class=\"lc-hero-br\">Satisfaction garantie 30 jours.");
patch("lc_hero", "Furnish your space. <br class=\"lc-hero-br\">Free shipping across Canada.", "Furnish your space. <br class=\"lc-hero-br\">30-day satisfaction guarantee.");

// why_us first column: truck/"Livraison gratuite" -> grid/"Plus de 490 produits"
const OLD = `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h13v11H1z"/><path d="M14 7h4l3 3v5h-7z"/><circle cx="5.5" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg></div><h3 style="font-size:1.5rem;margin:0 0 .25rem;color:#1A1A2E">Livraison gratuite</h3><p style="font-size:1.3rem;margin:0;color:#797068">Partout au Canada, sans frais</p>`;
const NEW = `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div><h3 style="font-size:1.5rem;margin:0 0 .25rem;color:#1A1A2E">Plus de 490 produits</h3><p style="font-size:1.3rem;margin:0;color:#797068">Meubles, extérieur, jardin et animaux</p>`;
patch("why_us", OLD, NEW);

await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW);
console.log("index.json PUT 200");

// verify
const v = JSON.parse(await getAsset("templates/index.json", PREVIEW));
const home = JSON.stringify(v.sections);
console.log("hero has 'Satisfaction garantie 30 jours':", v.sections.lc_hero.settings.custom_liquid.includes("Satisfaction garantie 30 jours"));
console.log("why_us has 'Plus de 490 produits':", v.sections.why_us.settings.custom_liquid.includes("Plus de 490 produits"));
const liv = (home.match(/livraison gratuite/gi) || []).length;
console.log("'livraison gratuite' in index.json sections now:", liv, "(expect 1: lc_trustbar)");
