// Chantier 1 — premium navigation on the PREVIEW theme only.
//
// Target theme: 160213696617 (UNPUBLISHED). NEVER live 160059195497.
// The navigation menu is store-wide data (NOT theme-scoped), so editing the shared
// `main-menu` would change the LIVE storefront. Instead we create a SEPARATE
// `preview-main-menu` and point ONLY the preview theme's header at it; live keeps
// using `main-menu`, untouched. Idempotent.
import { gql, sleep } from "./_shopify-lib.mjs";
import { rest } from "./_shopify-lib.mjs";

const THEME = "160213696617";
const MENU_HANDLE = "preview-main-menu";
if (THEME === "160059195497") throw new Error("refusing to run against the LIVE theme");

async function getAsset(key) {
  const r = await rest(`/themes/${THEME}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`get ${key}: ${r.status}`);
  return (await r.json()).asset.value;
}
async function putAsset(key, value) {
  const r = await rest(`/themes/${THEME}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key, value } }) });
  if (!r.ok) throw new Error(`put ${key}: ${r.status} ${await r.text()}`);
  await sleep(550);
}

// Unsplash images per sub-category (from _unsplash-mega.mjs; ToS download already pinged).
const IMG = {
  "ensembles-de-patio": "https://images.unsplash.com/photo-1613685302957-3a6fc45346ef?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "chaises-et-tables-de-patio-1": "https://images.unsplash.com/photo-1617887021567-fe8d2480bd96?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "gazebos-parasols-et-abris": "https://images.unsplash.com/photo-1527359443443-84a48aec73d2?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "bbq-et-articles-de-cuisson-exterieurs": "https://images.unsplash.com/photo-1534177616072-ef7dc120449d?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "salon": "https://images.unsplash.com/photo-1484101403633-562f891dc89a?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "chambre-a-coucher": "https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "cuisine-et-salle-a-manger": "https://images.unsplash.com/photo-1593136596203-7212b076f4d2?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "bureau": "https://images.unsplash.com/photo-1493934558415-9d19f0b2b4d2?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
};

// Menu structure → collection handles (Déco reuses meubles-et-decorations; no dedicated
// Déco collection exists — flagged for Mat).
const NEEDED = ["rabais", "mobiliers-exterieurs-et-jardins", "meubles-et-decorations",
  "ensembles-de-patio", "chaises-et-tables-de-patio-1", "gazebos-parasols-et-abris",
  "bbq-et-articles-de-cuisson-exterieurs", "salon", "chambre-a-coucher",
  "cuisine-et-salle-a-manger", "bureau", "jardinage-et-serres", "accessoires-pour-animaux"];

// 1. handle -> collection gid
console.log("Resolving collection gids…");
const gid = {};
let cur = null;
while (true) {
  const q = await gql(`query($c:String){ collections(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ id handle } } }`, { c: cur });
  for (const n of q.data.collections.nodes) gid[n.handle] = n.id;
  if (!q.data.collections.pageInfo.hasNextPage) break;
  cur = q.data.collections.pageInfo.endCursor;
}
for (const h of NEEDED) if (!gid[h]) throw new Error(`collection not found: ${h}`);
const col = (h) => ({ type: "COLLECTION", resourceId: gid[h] });

// 2. build menu items
const items = [
  { title: "Rabais 🔥", ...col("rabais") },
  { title: "Mobilier extérieur", ...col("mobiliers-exterieurs-et-jardins"), items: [
    { title: "Ensembles de patio", ...col("ensembles-de-patio") },
    { title: "Chaises et tables de patio", ...col("chaises-et-tables-de-patio-1") },
    { title: "Gazébos, parasols et abris", ...col("gazebos-parasols-et-abris") },
    { title: "BBQ et cuisson extérieure", ...col("bbq-et-articles-de-cuisson-exterieurs") },
  ] },
  { title: "Meubles", ...col("meubles-et-decorations"), items: [
    { title: "Salon", ...col("salon") },
    { title: "Chambre à coucher", ...col("chambre-a-coucher") },
    { title: "Cuisine et salle à manger", ...col("cuisine-et-salle-a-manger") },
    { title: "Bureau", ...col("bureau") },
  ] },
  { title: "Jardin", ...col("jardinage-et-serres") },
  { title: "Animaux", ...col("accessoires-pour-animaux") },
  { title: "Déco", ...col("meubles-et-decorations") },
  { title: "Catalogue", type: "CATALOG" },
];

// 3. create or update preview-main-menu (idempotent by handle)
const existing = await gql(`{ menus(first:50){ nodes{ id handle } } }`);
const found = existing.data.menus.nodes.find((m) => m.handle === MENU_HANDLE);
let menuRes;
if (found) {
  menuRes = await gql(`mutation($id:ID!,$title:String!,$items:[MenuItemUpdateInput!]!){ menuUpdate(id:$id,title:$title,items:$items){ menu{id handle} userErrors{field message} } }`,
    { id: found.id, title: "Menu preview (premium)", items });
  const e = menuRes.data.menuUpdate.userErrors; if (e.length) throw new Error("menuUpdate: " + JSON.stringify(e));
  console.log(`✔ menuUpdate ${MENU_HANDLE} (${found.id})`);
} else {
  menuRes = await gql(`mutation($title:String!,$handle:String!,$items:[MenuItemCreateInput!]!){ menuCreate(title:$title,handle:$handle,items:$items){ menu{id handle} userErrors{field message} } }`,
    { title: "Menu preview (premium)", handle: MENU_HANDLE, items });
  const e = menuRes.data.menuCreate.userErrors; if (e.length) throw new Error("menuCreate: " + JSON.stringify(e));
  console.log(`✔ menuCreate ${MENU_HANDLE}`);
}

// 4. mega-menu.liquid snippet (image cards keyed by collection handle in the url)
const cases = Object.entries(IMG).map(([h, u]) => `      {%- when '${h}' -%}{%- assign img = '${u}' -%}`).join("\n");
const megaSnippet = `{% comment %}
  Premium mega-menu panel — image card per sub-category. Image resolved from the
  collection handle embedded in each child link's URL. Render: {% render 'mega-menu', link: link %}
{% endcomment %}
<div class="lc-mega page-width">
  {%- for childlink in link.links -%}
    {%- assign seg = childlink.url | split: '/collections/' | last | split: '?' | first | split: '#' | first -%}
    {%- assign img = '' -%}
    {%- case seg -%}
${cases}
    {%- endcase -%}
    <a class="lc-mega-card" href="{{ childlink.url }}">
      {%- if img != blank -%}<span class="lc-mega-img" style="background-image:url('{{ img }}')"></span>{%- else -%}<span class="lc-mega-img lc-mega-img--ph"></span>{%- endif -%}
      <span class="lc-mega-name">{{ childlink.title | escape }}</span>
    </a>
  {%- endfor -%}
  <a class="lc-mega-all" href="{{ link.url }}">Voir tout « {{ link.title | escape }} » &rarr;</a>
</div>
<style>
  .lc-mega{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 0 28px;font-family:'DM Sans',sans-serif}
  .lc-mega-card{display:block;text-decoration:none;color:#1B2A4A}
  .lc-mega-img{display:block;width:100%;aspect-ratio:4/3;border-radius:10px;background-size:cover;background-position:center;box-shadow:0 2px 10px rgba(27,42,74,.12);transition:transform .2s ease,box-shadow .2s ease}
  .lc-mega-img--ph{background:#ECE7E1}
  .lc-mega-card:hover .lc-mega-img{transform:translateY(-3px);box-shadow:0 10px 24px rgba(27,42,74,.20)}
  .lc-mega-name{display:block;margin-top:.55rem;font-size:1.4rem;font-weight:600}
  .lc-mega-card:hover .lc-mega-name{color:#C17F3E}
  .lc-mega-all{grid-column:1 / -1;justify-self:start;margin-top:.3rem;font-weight:700;font-size:1.35rem;color:#C17F3E;text-decoration:none}
  .lc-mega-all:hover{text-decoration:underline}
  @media(max-width:989px){.lc-mega{grid-template-columns:repeat(2,1fr)}}
</style>
`;
await putAsset("snippets/mega-menu.liquid", megaSnippet);
console.log("✔ PUT snippets/mega-menu.liquid");

// 5. clean header-mega-menu.liquid — delegate mega panel content to mega-menu.liquid
const headerMega = `{% comment %}
  Renders the header menu. Mega panels (items with children) delegate to the
  premium image-card snippet 'mega-menu'. Usage: {% render 'header-mega-menu' %}
{% endcomment %}
<nav class="header__inline-menu">
  <ul class="list-menu list-menu--inline" role="list">
    {%- for link in section.settings.menu.links -%}
      <li>
        {%- if link.links != blank -%}
          <header-menu>
            <details id="Details-HeaderMenu-{{ forloop.index }}" class="mega-menu">
              <summary id="HeaderMenu-{{ link.handle }}" class="header__menu-item list-menu__item link focus-inset">
                <span{% if link.child_active %} class="header__active-menu-item"{% endif %}>{{ link.title | escape }}</span>
                {{- 'icon-caret.svg' | inline_asset_content -}}
              </summary>
              <div id="MegaMenu-Content-{{ forloop.index }}" class="mega-menu__content color-{{ section.settings.menu_color_scheme }} gradient motion-reduce global-settings-popup" tabindex="-1">
                {% render 'mega-menu', link: link %}
              </div>
            </details>
          </header-menu>
        {%- else -%}
          <a id="HeaderMenu-{{ link.handle }}" href="{{ link.url }}" class="header__menu-item list-menu__item link link--text focus-inset"{% if link.current %} aria-current="page"{% endif %}>
            <span{% if link.current %} class="header__active-menu-item"{% endif %}>{{ link.title | escape }}</span>
          </a>
        {%- endif -%}
      </li>
    {%- endfor -%}
  </ul>
</nav>
`;
await putAsset("snippets/header-mega-menu.liquid", headerMega);
console.log("✔ PUT snippets/header-mega-menu.liquid");

// 6. point the preview header at preview-main-menu (sticky stays as-is)
const hg = JSON.parse(await getAsset("sections/header-group.json"));
const before = hg.sections.header.settings.menu;
hg.sections.header.settings.menu = MENU_HANDLE;
hg.sections.header.settings.menu_type_desktop = "mega";
await putAsset("sections/header-group.json", JSON.stringify(hg, null, 2));
console.log(`✔ PUT sections/header-group.json (menu ${before} -> ${MENU_HANDLE}, type mega, sticky ${hg.sections.header.settings.sticky_header_type})`);

console.log(`\nDone on PREVIEW ${THEME}. Live 160059195497 untouched (separate menu).`);
console.log("Preview: https://27u5y2-kp.myshopify.com/?preview_theme_id=" + THEME);
