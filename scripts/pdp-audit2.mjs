import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
console.log("===== snippets/price.liquid (FULL) =====");
console.log(await getAsset("snippets/price.liquid", P));
console.log("\n\n===== trust_badges block custom_liquid =====");
const pj = JSON.parse(await getAsset("templates/product.json", P));
console.log(pj.sections.main.blocks.trust_badges.settings.custom_liquid);
console.log("\n===== judgeme_widgets snippet exists? =====");
try { const s = await getAsset("snippets/judgeme_widgets.liquid", P); console.log("YES, len", s.length); } catch { console.log("NO"); }
console.log("\n===== how main-product renders media (gallery) =====");
const mp = await getAsset("sections/main-product.liquid", P);
const gi = mp.search(/render 'product-media-gallery'|media-gallery|product__media-wrapper|featured_media/);
console.log(gi >= 0 ? mp.slice(gi - 40, gi + 200) : "(gallery marker not found)");
