// Read-only audit for the homepage premium redesign (preview 160213696617).
import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";

// 1+4. Home sections + order
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
console.log("=== HOME SECTION ORDER (" + idx.order.length + ") ===");
idx.order.forEach((id, i) => {
  const s = idx.sections[id];
  const h = s.settings?.heading || s.settings?.title || "";
  const coll = s.settings?.collection ? ` collection=${s.settings.collection}` : "";
  const nb = s.blocks ? ` blocks=${Object.keys(s.blocks).length}` : "";
  console.log(`${String(i + 1).padStart(2)}. ${id} [${s.type}]${h ? ` "${h}"` : ""}${coll}${nb}`);
});

// 5. Category buttons — collection_list section
console.log("\n=== CATEGORY BUTTONS (collection_list) ===");
const cl = idx.sections.collection_list;
if (cl) {
  console.log(`section collection_list [${cl.type}] settings=${JSON.stringify(cl.settings)}`);
  const order = cl.block_order || Object.keys(cl.blocks || {});
  for (const bid of order) {
    const b = cl.blocks[bid];
    console.log(`  [${b.type}] ${JSON.stringify(b.settings)}`);
  }
} else console.log("(no collection_list section found)");

// 2. header-group.json (announcement bar + nav)
console.log("\n=== header-group.json ===");
const hg = JSON.parse(await getAsset("sections/header-group.json", PREVIEW));
console.log("order:", hg.order.join(", "));
for (const [id, s] of Object.entries(hg.sections)) {
  console.log(`- ${id} [${s.type}]`);
  if (s.blocks) for (const [bid, b] of Object.entries(s.blocks)) {
    const txt = b.settings?.text || b.settings?.menu || JSON.stringify(b.settings).slice(0, 90);
    console.log(`    [${b.type}] ${String(txt).slice(0, 100)}`);
  }
}

// 3. "livraison" across all preview assets
console.log('\n=== "livraison" occurrences (all preview assets) ===');
const assets = (await (await rest(`/themes/${PREVIEW}/assets.json`)).json()).assets;
const textKeys = assets.map((a) => a.key).filter((k) => /\.(liquid|json)$/.test(k));
let total = 0;
for (const key of textKeys) {
  let v;
  try { v = await getAsset(key, PREVIEW); } catch { continue; }
  if (key === "templates/index.json") {
    const j = JSON.parse(v);
    for (const [id, sec] of Object.entries(j.sections)) {
      const cnt = (JSON.stringify(sec).match(/livraison gratuite/gi) || []).length;
      if (cnt) { console.log(`  index.json → ${id} [${sec.type}]: ${cnt}× "livraison gratuite"`); total += cnt; }
    }
  } else {
    const cnt = (v.match(/livraison gratuite/gi) || []).length;
    if (cnt) { console.log(`  ${key}: ${cnt}× "livraison gratuite"`); total += cnt; }
  }
}
console.log(`TOTAL "livraison gratuite" (all preview assets): ${total}`);
