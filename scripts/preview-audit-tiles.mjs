import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
const idx = JSON.parse(await getAsset("templates/index.json", P));

const dump = (id) => {
  const s = idx.sections[id];
  if (!s) return { id, missing: true };
  const body = (s.settings && (s.settings.custom_liquid || s.settings.code || JSON.stringify(s.settings))) || "";
  return {
    id,
    type: s.type,
    svgCount: (body.match(/<svg/gi) || []).length,
    navy: /1B2A4A/i.test(body),
    imgTags: (body.match(/<img/gi) || []).length,
    unsplash: /unsplash/i.test(body),
    cdnImg: /cdn\.shopify|shopify\.com|\.(jpg|jpeg|png|webp)/i.test(body),
    livraisonGratuite: (body.match(/livraison gratuite/gi) || []).length,
    snippetLen: body.length,
  };
};

console.log(JSON.stringify({ cat_tiles: dump("cat_tiles"), why_us: dump("why_us") }, null, 2));

// liquid-tag balance across key assets (best-effort "0 liquid error" proxy)
const keys = ["sections/home-video-showcase.liquid", "sections/page-voyez-le.liquid", "sections/main-product.liquid", "snippets/mega-menu.liquid"];
const bal = {};
for (const k of keys) {
  const b = await getAsset(k, P);
  const open = (b.match(/{%-?\s*(if|for|unless|case|capture|paginate|form|tablerow|comment|schema|javascript|style|stylesheet)\b/g) || []).length;
  const close = (b.match(/{%-?\s*end(if|for|unless|case|capture|paginate|form|tablerow|comment|schema|javascript|style|stylesheet)\b/g) || []).length;
  bal[k] = { opens: open, closes: close, balanced: open === close, schemaValid: !/\{%\s*schema\s*%\}/.test(b) || /\{%\s*endschema\s*%\}/.test(b) };
}
console.log(JSON.stringify({ liquidBalance: bal }, null, 2));
