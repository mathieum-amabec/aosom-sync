// PDP + cat_tiles second pass — correct Liquid files this time.
import { rest, getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
const grab = async (k) => { try { return await getAsset(k, P); } catch { return null; } };

const mainProduct = await grab("sections/main-product.liquid");
const productTpl = await grab("templates/product.json");
const related = await grab("sections/related-products.liquid");
const swatch = await grab("snippets/swatch.liquid");
const swatchInput = await grab("snippets/swatch-input.liquid");
const variantPicker = await grab("snippets/product-variant-picker.liquid");

const blob = [mainProduct, productTpl, related, swatch, swatchInput, variantPicker].filter(Boolean).join("\n\n");

// color-map snippet hunt: list assets that mention French colours
const assets = (await (await rest(`/themes/${P}/assets.json`)).json()).assets.map((a) => a.key);
const out = {};
out.PDP = {
  mainProductPresent: !!mainProduct,
  eyebrow: /eyebrow|sur-?titre|product__category|category-eyebrow|categorie/i.test(blob),
  judgeme: /jdgm|judge\.?me|judgeme/i.test(blob),
  atcNavy: /1B2A4A/i.test(mainProduct || "") || /1B2A4A/i.test(blob),
  atcColorRefs: ((mainProduct || "").match(/1B2A4A/gi) || []).length,
  crossSellRelated: !!related,
  crossSellHeading: /aimerez aussi|vous aimerez/i.test(blob),
  templateBlocks: productTpl ? Object.values(JSON.parse(productTpl).sections || {}).map((s) => s.type) : null,
};

// swatch / colour-map entries: search every asset whose body has the BK=>Noir style map
const colourHits = [];
for (const k of assets.filter((k) => /\.(liquid|js|json)$/.test(k) && /(swatch|color|colour|variant|product|map)/i.test(k))) {
  const body = await grab(k);
  if (!body) continue;
  // FR colour names typical of COLOR_MAP
  const frHits = (body.match(/Noir|Blanc|Gris|Beige|Brun|Bleu|Vert|Rouge|Rose|Jaune/gi) || []).length;
  const pairHits = (body.match(/['"][A-Z]{2}['"]\s*[:=>]/g) || []).length;
  if (frHits > 5 || pairHits > 5) colourHits.push({ file: k, frColourWords: frHits, twoLetterKeys: pairHits, bilingual: /_en|title_en|english|\bEN\b/i.test(body) });
}
out.PDP.colourMapCandidates = colourHits;
console.log(JSON.stringify(out, null, 2));
