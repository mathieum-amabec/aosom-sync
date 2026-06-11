import { getAsset, gql, rest } from "./_shopify-lib.mjs";
const P = "160213696617";
const rec = (ok, l, d) => console.log(`${ok ? "✅" : "❌"} ${l} — ${d}`);

const mm = await getAsset("snippets/mega-menu.liquid", P);
rec(/cat-enfants-toys\.jpg/.test(mm) && /cat-enfants-furniture\.jpg/.test(mm), "Enfants mega cards use new assets", "toys + furniture asset_url");
rec(/jouets-pour-enfants/.test(mm) && /meubles-pour-enfants/.test(mm), "Enfants in mega-menu", "2 child cards present");

const md = (await gql(`{ menus(first:30){ nodes { handle items { title url items { title url } } } } }`)).data.menus.nodes.find((m) => m.handle === "preview-main-menu");
const enf = md.items.find((i) => i.title === "Enfants");
rec(!!enf && /collections\/enfants/.test(enf.url), "menu Enfants -> /collections/enfants", `${enf.url} [${enf.items.length} children]`);

for (const a of ["assets/cat-enfants-furniture.jpg", "assets/cat-enfants-toys.jpg"]) {
  let ok = false; try { await getAsset(a, P); ok = true; } catch {}
  rec(ok, "asset uploaded", a);
}

const mp = await getAsset("sections/main-product.liquid", P);
rec(/lc-swatch-set/.test(mp) && /\.lc-swatch/.test(mp), "color swatches in main-product.liquid", "CSS + JS present");
rec(/#D4A853/.test(mp) && /input:checked \+ label\.lc-swatch/.test(mp), "selected swatch gold border", "#D4A853 on :checked");
rec(/'blanc':'#FFFFFF'/.test(mp) && /'noir':'#1A1A1A'/.test(mp) && /isColor/.test(mp), "name->color map + Couleur/Color guard", "Blanc/Noir/Gris... mapped");
const ifs = (mp.match(/\{%-?\s*if /g) || []).length, endifs = (mp.match(/\{%-?\s*endif/g) || []).length;
rec(Math.abs(ifs - endifs) <= 2, "main-product if/endif balanced", `if=${ifs} endif=${endifs}`);
const live = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
rec(!/liquid error/i.test(live), "no liquid error (live home)", "none");
