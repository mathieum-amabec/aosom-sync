import { loadEnv, gql } from "./_shopify-lib.mjs";
const key = loadEnv().UNSPLASH_ACCESS_KEY;
// Unsplash: 2 images
for (const q of ["children bedroom furniture", "kids toys playroom"]) {
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&orientation=landscape&per_page=4&content_filter=high`, { headers: { Authorization: `Client-ID ${key}` } });
  const d = await r.json();
  const top = (d.results || [])[0];
  console.log(`\n[${q}] status ${r.status}`);
  if (top) console.log(`  id=${top.id} ${top.width}x${top.height} by ${top.user?.name} | ${(top.description||top.alt_description||'').slice(0,50)}\n  base=${top.urls.raw.split('?')[0]}\n  dl=${top.links.download_location}`);
}
// Full preview-main-menu with types for menuUpdate
const md = (await gql(`{ menus(first:30){ nodes { id handle title items { id title type url resourceId items { id title type url resourceId } } } } }`)).data.menus.nodes.find(m=>m.handle==="preview-main-menu");
console.log("\n=== preview-main-menu structure (for menuUpdate) ===");
console.log("id:", md.id);
console.log(JSON.stringify(md.items, null, 1));
