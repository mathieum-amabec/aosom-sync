// CHANTIER 1 — Enfants mega images + parent -> /collections/enfants (PREVIEW only).
import { loadEnv, rest, gql, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");
const env = loadEnv();

// enfants collection gid
const sc = (await (await rest("/smart_collections.json?limit=250")).json()).smart_collections || [];
const cc = (await (await rest("/custom_collections.json?limit=250")).json()).custom_collections || [];
const enf = [...sc, ...cc].find((c) => c.handle === "enfants");
if (!enf) throw new Error("ABORT: enfants collection not found");
const enfGid = `gid://shopify/Collection/${enf.id}`;
console.log("enfants collection:", enfGid, enf.title);

// 1. upload 2 images
const imgs = [
  ["cat-enfants-furniture.jpg", "or8te0rje5g", "photo-1721395288477-b546804ce392"],
  ["cat-enfants-toys.jpg", "FHFfHWWzbCc", "photo-1596066190600-3af9aadaaea1"],
];
for (const [key, id, base] of imgs) {
  try { const d = await fetch(`https://api.unsplash.com/photos/${id}/download`, { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` } }); process.stdout.write(`ping ${id}:${d.status} `); } catch {}
  const src = `https://images.unsplash.com/${base}?w=440&h=300&fit=crop&crop=entropy&q=80&fm=jpg`;
  const r = await rest(`/themes/${PREVIEW}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key: `assets/${key}`, src } }) });
  console.log(`\n  assets/${key}: ${r.status}`);
}

// 2. mega-menu.liquid: swap the 2 Enfants case images to the new assets
let mm = await getAsset("snippets/mega-menu.liquid", PREVIEW);
const repl = [
  ["{%- when 'jouets-pour-enfants' -%}{%- assign img = 'https://images.unsplash.com/photo-1545558014-8692077e9b5c?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80' -%}", "{%- when 'jouets-pour-enfants' -%}{%- assign img = 'cat-enfants-toys.jpg' | asset_url -%}"],
  ["{%- when 'meubles-pour-enfants' -%}{%- assign img = 'https://images.unsplash.com/photo-1721395288477-b546804ce392?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80' -%}", "{%- when 'meubles-pour-enfants' -%}{%- assign img = 'cat-enfants-furniture.jpg' | asset_url -%}"],
];
for (const [o, n] of repl) {
  if (mm.includes(n)) { console.log("mega: already patched"); continue; }
  if (!mm.includes(o)) throw new Error("ABORT: mega case not found: " + o.slice(0, 50));
  mm = mm.replace(o, n);
}
await putAsset("snippets/mega-menu.liquid", mm, PREVIEW);
console.log("mega-menu.liquid PUT 200 (Enfants cards -> new assets)");

// 3. menuUpdate: rebuild items faithfully, Enfants parent -> enfants collection
const md = (await gql(`{ menus(first:30){ nodes { id handle title items { title type url resourceId items { title type url resourceId } } } } }`)).data.menus.nodes.find((m) => m.handle === "preview-main-menu");
function toInput(it, isEnfantsParent) {
  const o = { title: it.title, type: it.type };
  if (isEnfantsParent) { o.resourceId = enfGid; }      // point Enfants -> enfants collection
  else if (it.resourceId) o.resourceId = it.resourceId;
  if (it.type === "CATALOG" || it.type === "HTTP") o.url = it.url;
  if (it.items && it.items.length) o.items = it.items.map((c) => toInput(c, false));
  return o;
}
const items = md.items.map((it) => toInput(it, it.title === "Enfants"));
const res = await gql(
  `mutation($id:ID!,$items:[MenuItemUpdateInput!]!){ menuUpdate(id:$id, title:"Preview Main Menu", handle:"preview-main-menu", items:$items){ menu{ id items{ title url } } userErrors{ field message } } }`,
  { id: md.id, items }
);
const ue = res.data.menuUpdate.userErrors;
if (ue && ue.length) { console.log("menuUpdate userErrors:", JSON.stringify(ue)); throw new Error("menuUpdate failed"); }
const enfItem = res.data.menuUpdate.menu.items.find((i) => i.title === "Enfants");
console.log("menuUpdate OK. Enfants ->", enfItem.url, "(children preserved)");
