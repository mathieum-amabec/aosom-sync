// C2 — EN parity for the featured_sale subtitle + cross-sell heading. PREVIEW only.
// These are user-set native section settings (not localizable via locale files or the public
// Translations API), so true bilingual rendering is done in the section liquids (gated on the
// specific FR text → other section instances unaffected). The en.default.json keys are added
// as requested. Idempotent. PUT main assets + locales/en.default.json.
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
const log = [];

// 1. related-products heading → bilingual (cross-sell, single instance)
let rp = await get("sections/related-products.liquid");
if (!rp.includes("You might also like")) {
  rp = rp.replace("{{ section.settings.heading }}",
    "{%- if request.locale.iso_code == 'en' and section.settings.heading contains 'aimerez' -%}You might also like{%- else -%}{{ section.settings.heading }}{%- endif -%}");
  if (!rp.includes("You might also like")) throw new Error("related-products heading anchor not found");
  log.push(`related-products.liquid heading bilingual → ${await put("sections/related-products.liquid", rp)}`);
} else log.push("related-products heading already bilingual");

// 2. featured-collection description → bilingual (only the sale subtitle)
let fc = await get("sections/featured-collection.liquid");
if (!fc.includes("Unbeatable prices on our favourite picks")) {
  fc = fc.replace("{{ section.settings.description -}}",
    "{%- if request.locale.iso_code == 'en' and section.settings.description contains 'imbattables' -%}<p>Unbeatable prices on our favourite picks.</p>{%- else -%}{{ section.settings.description -}}{%- endif -%}");
  if (!fc.includes("Unbeatable prices on our favourite picks")) throw new Error("featured-collection description anchor not found");
  log.push(`featured-collection.liquid description bilingual → ${await put("sections/featured-collection.liquid", fc)}`);
} else log.push("featured-collection description already bilingual");

// 3. en.default.json keys (as requested)
const en = JSON.parse(await get("locales/en.default.json"));
en.sections = en.sections || {};
en.sections.featured_collection = { ...(en.sections.featured_collection || {}), subtitle: "Unbeatable prices on our favourite picks." };
en.sections.related_products = { ...(en.sections.related_products || {}), title: "You might also like" };
log.push(`locales/en.default.json keys added → ${await put("locales/en.default.json", JSON.stringify(en, null, 2))}`);

console.log(log.join("\n"));
console.log("\nNote: the bilingual rendering (section liquids) is what actually localizes; the en.default.json keys are added per request (inert for user-set values).");
