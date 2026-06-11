import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";
const handles = ["meubles-et-decorations", "mobiliers-exterieurs-et-jardins", "chaises-et-tables-de-patio-1", "jardinage-et-serres", "accessoires-pour-animaux", "sports-et-loisirs"];
const rec = (ok, label, detail) => console.log(`${ok ? "✅" : "❌"} ${label} — ${detail}`);

const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
const ct = idx.sections.cat_tiles?.settings?.custom_liquid || "";

rec(!!idx.sections.cat_tiles, "cat_tiles section present", idx.order.includes("cat_tiles") ? "in order" : "NOT in order");
rec(!idx.sections.collection_list && !idx.order.includes("collection_list"), "collection_list removed", "section + order");
const linked = handles.filter((h) => ct.includes(`/collections/${h}`)).length;
rec(linked === 6, "6 tiles link to collections", `${linked}/6 handles linked`);
rec(ct.includes("rgba(27,42,74,.5)"), "navy #1B2A4A 50% overlay", ct.includes("rgba(27,42,74,.5)") ? "present" : "missing");
rec(ct.includes("scale(1.02)"), "hover scale(1.02)", ct.includes("scale(1.02)") ? "present" : "missing");
rec(/DM Sans/.test(ct) && /font-weight:700/.test(ct), "white DM Sans Bold titles", "DM Sans + weight 700");

// assets present
let assetsOk = 0;
for (let i = 1; i <= 6; i++) { try { await getAsset(`assets/cat-tile-${i}.jpg`, PREVIEW); assetsOk++; } catch {} }
rec(assetsOk === 6, "6 tile images uploaded", `${assetsOk}/6 present on preview`);

// chantier 1
rec(idx.sections.lc_hero.settings.custom_liquid.includes("Satisfaction garantie 30 jours"), "hero free-shipping replaced", "now 'Satisfaction garantie 30 jours'");
rec(idx.sections.why_us.settings.custom_liquid.includes("Plus de 490 produits") && !idx.sections.why_us.settings.custom_liquid.includes("Livraison gratuite"), "why_us free-shipping replaced", "now 'Plus de 490 produits'");
const liv = (JSON.stringify(idx.sections).match(/livraison gratuite/gi) || []).length;
rec(liv === 1, "index.json livraison mentions", `${liv} (lc_trustbar) + announcement bar = 2 home total`);

// live fetch (published theme — informational)
const live = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
const livLive = (live.match(/livraison gratuite/gi) || []).length;
console.log(`\nℹ️ live home (PUBLISHED theme, not preview) "livraison gratuite" count: ${livLive} — preview changes verified via Admin API above; live reflects the currently-published theme.`);
rec(!/liquid error/i.test(live), "no liquid error (live home)", /liquid error/i.test(live) ? "FOUND" : "none");
