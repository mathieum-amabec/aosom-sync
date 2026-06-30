import { rest } from "./_shopify-lib.mjs";
const DRAFT="160606093417", LIVE="160584859753";
async function get(themeId,key){const r=await rest(`/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`);return (await r.json()).asset;}
// DRAFT state (parse-aware for JSON)
const idx=await get(DRAFT,"templates/index.json");
const cl=JSON.parse(idx.value).sections.cat_tiles.settings.custom_liquid;
console.log("P1 cat_tiles id=categories:", cl.includes('id="categories"'), "| scroll-margin:", cl.includes('scroll-margin-top:100px'));
const hero=JSON.parse(idx.value).sections.lc_hero.settings.custom_liquid;
console.log("   hero CTA -> #categories:", hero.includes('href="#categories"'));
const grid=await get(DRAFT,"sections/main-collection-product-grid.liquid");
console.log("P2 rabais banner:", /collection.handle == 'rabais'/.test(grid.value), "| price-ascending links:", (grid.value.match(/sort_by=price-ascending/g)||[]).length, "| gold promo pill:", grid.value.includes('quick-cat-pill--promo'));
const hv=await get(DRAFT,"sections/home-video-showcase.liquid");
console.log("P3 PawHut gone:", !/PawHut/.test(hv.value), "| video sources left:", (hv.value.match(/data-src=/g)||[]).length);
// LIVE untouched
const liveIdx=await get(LIVE,"templates/index.json");
console.log("\nLIVE index.json updated_at:", liveIdx.updated_at, "(baseline 2026-06-28T21:31:07-04:00)");
