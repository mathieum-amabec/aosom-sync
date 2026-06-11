import { getAsset, gql } from "./_shopify-lib.mjs";
const P = "160213696617";

// 1. preview-main-menu structure
const mq = `{ menus(first: 30) { nodes { id handle title items { title url tags resourceId items { title url } } } } }`;
const all = (await gql(mq)).data.menus.nodes;
const md = all.find((m) => m.handle === "preview-main-menu");
console.log("all menu handles:", all.map((m) => m.handle).join(", "));
console.log("=== preview-main-menu ===", md ? md.id : "(NOT FOUND)");
if (md) for (const it of md.items) console.log(`- ${it.title} -> ${it.url}` + (it.items?.length ? ` [${it.items.length} children: ${it.items.map(c => c.title + ' ' + c.url).join(", ")}]` : ""));

// 2. mega-menu.liquid: how cards are structured + is Enfants present
const mm = await getAsset("snippets/mega-menu.liquid", P);
console.log("\n=== mega-menu.liquid (" + mm.length + " chars) ===");
console.log("has 'Enfants':", /enfants/i.test(mm));
console.log("card class markers:", [...new Set((mm.match(/class="[^"]*mega[^"]*"/g) || []))].slice(0, 6).join(" | "));
// show the structure: find how a category block is keyed (whens / if on item.title?)
const whenCases = [...mm.matchAll(/\{%-?\s*when\s+'([^']+)'/g)].map(m => m[1]);
const ifTitles = [...mm.matchAll(/(?:title|handle)[^=]*==\s*'([^']+)'/g)].map(m => m[1]);
console.log("when cases:", whenCases.join(", ") || "(none)");
console.log("if title/handle matches:", ifTitles.slice(0, 20).join(", ") || "(none)");
// dump first ~900 chars to see structure
console.log("--- head of mega-menu.liquid ---");
console.log(mm.slice(0, 1100));

// 3. main-product.liquid variant picker
const mp = await getAsset("sections/main-product.liquid", P);
console.log("\n\n=== main-product.liquid variant picker ===");
const vi = mp.search(/when 'variant_picker'/);
console.log(vi >= 0 ? mp.slice(vi, vi + 320) : "(variant_picker case not found)");
console.log("renders product-variant-picker:", /product-variant-picker/.test(mp));
console.log("has swatch:", /swatch/i.test(mp), "| has 'Couleur'/'Color' handling:", /Couleur|option.*color|color.*swatch/i.test(mp));
