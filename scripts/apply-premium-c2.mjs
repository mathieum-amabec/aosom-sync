// CHANTIER 2 — premium category tiles on PREVIEW (Unsplash bg + navy overlay + hover).
// Replaces the native collection_list with a custom-liquid tile grid. PREVIEW only.
import { loadEnv, rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";
const LIVE = LIVE_THEME_ID, PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");
console.log(`Target: ${t.id} "${t.name}" [${t.role}]`);
const env = loadEnv();

const tiles = [
  { handle: "meubles-et-decorations", fr: "Meubles et décorations", en: "Furniture & decor", id: "c0JoR_-2x3E", base: "photo-1631679706909-1844bbd07221" },
  { handle: "mobiliers-exterieurs-et-jardins", fr: "Mobilier extérieur et jardin", en: "Outdoor & garden", id: "Tk1pmgowG0w", base: "photo-1613685302957-3a6fc45346ef" },
  { handle: "chaises-et-tables-de-patio-1", fr: "Chaises et tables de patio", en: "Patio chairs & tables", id: "Ja9KHBwMWWg", base: "photo-1617887021567-fe8d2480bd96" },
  { handle: "jardinage-et-serres", fr: "Jardinage et serres", en: "Gardening & greenhouses", id: "qM_2NDZFs9g", base: "photo-1634316888962-75074307f81c" },
  { handle: "accessoires-pour-animaux", fr: "Accessoires pour animaux", en: "Pet supplies", id: "-itLKdE7ojA", base: "photo-1526363269865-60998e11d82d" },
  { handle: "sports-et-loisirs", fr: "Sports et loisirs", en: "Sports & leisure", id: "pYXG2Hot6d8", base: "photo-1773447593730-fff2262487f4" },
];

// 1. Upload each as a preview asset (with Unsplash download ping per ToS).
for (let i = 0; i < tiles.length; i++) {
  const tdef = tiles[i];
  try {
    const dl = await fetch(`https://api.unsplash.com/photos/${tdef.id}/download`, { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` } });
    process.stdout.write(`ping ${tdef.id}:${dl.status} `);
  } catch {}
  const src = `https://images.unsplash.com/${tdef.base}?w=640&h=440&fit=crop&crop=entropy&q=80&fm=jpg`;
  const key = `assets/cat-tile-${i + 1}.jpg`;
  const res = await rest(`/themes/${PREVIEW}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key, src } }) });
  console.log(`\n  ${key}: ${res.status} ${res.ok ? "OK" : await res.text()}`);
  tdef.asset = `cat-tile-${i + 1}.jpg`;
}

// 2. Build the premium tile grid custom_liquid.
const tileHtml = tiles.map((td) =>
  `    <a class="lc-cat-tile" href="/collections/${td.handle}" data-umami-event="Cat tile ${td.en}" style="background-image:url('{{ '${td.asset}' | asset_url }}')"><span class="lc-cat-ov"></span><span class="lc-cat-t">{% if loc == 'en' %}${td.en}{% else %}${td.fr}{% endif %}</span></a>`
).join("\n");
const CL = `{%- assign loc = request.locale.iso_code | downcase -%}
<div class="page-width lc-cat" style="padding:48px 0 60px">
  <h2 style="font-family:'DM Sans',sans-serif;font-size:clamp(2rem,3.5vw,2.6rem);text-align:center;margin:0 0 1.8rem;color:#1A1A2E">{% if loc == 'en' %}Shop by category{% else %}Magasinez par catégorie{% endif %}</h2>
  <div class="lc-cat-grid">
${tileHtml}
  </div>
</div>
<style>
.lc-cat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.lc-cat-tile{position:relative;display:flex;align-items:center;justify-content:center;min-height:200px;border-radius:10px;overflow:hidden;background-size:cover;background-position:center;text-decoration:none;transition:transform .25s ease}
.lc-cat-ov{position:absolute;inset:0;background:rgba(27,42,74,.5);transition:background .25s ease}
.lc-cat-t{position:relative;z-index:1;color:#fff;font-family:'DM Sans',sans-serif;font-weight:700;font-size:1.7rem;text-align:center;padding:0 14px;text-shadow:0 1px 4px rgba(0,0,0,.4)}
.lc-cat-tile:hover{transform:scale(1.02)}
.lc-cat-tile:hover .lc-cat-ov{background:rgba(27,42,74,.32)}
@media(max-width:749px){.lc-cat-grid{grid-template-columns:repeat(2,1fr);gap:12px}.lc-cat-tile{min-height:150px}.lc-cat-t{font-size:1.4rem}}
</style>`;

// 3. Replace collection_list with cat_tiles in index.json.
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
idx.sections.cat_tiles = { type: "custom-liquid", settings: { custom_liquid: CL, color_scheme: "", padding_top: 0, padding_bottom: 0 } };
const pos = idx.order.indexOf("collection_list");
if (pos >= 0) idx.order.splice(pos, 1, "cat_tiles");
else idx.order.splice(idx.order.indexOf("featured_sale") + 1, 0, "cat_tiles");
delete idx.sections.collection_list;
await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW);
console.log("\nindex.json PUT 200. order:", idx.order.join(", "));
