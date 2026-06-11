import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
const mp = await getAsset("sections/main-product.liquid", P);
const win = (label, idx, before = 80, after = 220) => { if (idx < 0) { console.log(`\n[${label}] NOT FOUND`); return; } console.log(`\n[${label}] @${idx}`); console.log(mp.slice(idx - before, idx + after).replace(/\n{2,}/g, "\n")); };

console.log("=== main-product.liquid (98KB) key regions ===");
win("title block case", mp.search(/when 'title'/));
win("<h1", mp.search(/<h1/i));
win("buy_buttons block case", mp.search(/when 'buy_buttons'/));
win("render buy-buttons", mp.search(/render 'buy-buttons'/));
win("render price", mp.search(/render 'price'/));
console.log("\nproduct.type used:", /product\.type/.test(mp), "| product-eyebrow:", /product-eyebrow/.test(mp));
console.log("judgeme/judge.me in main-product:", /judge/i.test(mp));
console.log("'product-eyebrow' present:", /product-eyebrow/.test(mp));
console.log("buy_buttons block count:", (mp.match(/when 'buy_buttons'/g) || []).length, "| title:", (mp.match(/when 'title'/g) || []).length);

// price.liquid
console.log("\n\n=== snippets/price.liquid ===");
const price = await getAsset("snippets/price.liquid", P);
console.log("len", price.length, "| has compare_at:", /compare_at_price/.test(price), "| has 'save'/économ:", /save|économ|economis/i.test(price), "| discount_pct:", /discount/i.test(price));
const saveIdx = price.search(/save|économ|economis|badge/i);
if (saveIdx >= 0) console.log("savings region:", price.slice(saveIdx - 60, saveIdx + 200));

// buy-buttons.liquid
console.log("\n=== snippets/buy-buttons.liquid (ATC) ===");
const bb = await getAsset("snippets/buy-buttons.liquid", P);
console.log("len", bb.length, "| name=add:", /name="add"/.test(bb), "| product-form__submit:", /product-form__submit/.test(bb));

// product.json block order + judge.me
console.log("\n=== templates/product.json ===");
const pj = JSON.parse(await getAsset("templates/product.json", P));
for (const [sid, sec] of Object.entries(pj.sections)) {
  console.log(`section ${sid} [${sec.type}]`);
  if (sec.block_order) console.log("  block_order:", sec.block_order.join(", "));
  if (sec.blocks) for (const [bid, b] of Object.entries(sec.blocks)) if (/judge/i.test(JSON.stringify(b))) console.log("  JUDGE block:", bid, b.type);
}
