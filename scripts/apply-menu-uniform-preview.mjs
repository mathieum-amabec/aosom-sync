// Chantier 2 (catalog-fit) — uniform image mega-menu for every category the catalog
// supports, on the PREVIEW theme only (160213696617). Never live.
//
// The navigation menu is store-wide data, so a SEPARATE `preview-main-menu` is used and
// only the preview header points at it (live keeps `main-menu`). Self-contained &
// idempotent: re-applies the menu, the mega snippet (image cards for all sub-cats), the
// header delegation, and the header repoint.
//
// Catalog reality (audit): only Mobilier extérieur (8 cols) and Meubles (6) support 4
// sub-cats; Animaux has 3, Enfants 2; Jardin 1; Déco/Électronique have no dedicated
// collections (Mat: drop them). So: mega for Mobilier ext (4) / Meubles (4) / Animaux (3)
// / Enfants (2); Rabais, Jardin, Coups de cœur, Catalogue are direct links.
import { gql, rest, sleep, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const THEME = "160213696617";
const MENU_HANDLE = "preview-main-menu";
if (THEME === LIVE_THEME_ID) throw new Error("refusing to run against the LIVE theme");
const getAsset = async (k) => (await (await rest(`/themes/${THEME}/assets.json?asset[key]=${encodeURIComponent(k)}`)).json()).asset.value;
async function putAsset(k, v) {
  const r = await rest(`/themes/${THEME}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key: k, value: v } }) });
  if (!r.ok) throw new Error(`put ${k}: ${r.status} ${await r.text()}`);
  await sleep(550);
  return r.status;
}

// 13 sub-category images (Unsplash; ToS download pinged at fetch time).
const IMG = {
  "ensembles-de-patio": "https://images.unsplash.com/photo-1613685302957-3a6fc45346ef?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "chaises-et-tables-de-patio-1": "https://images.unsplash.com/photo-1617887021567-fe8d2480bd96?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "gazebos-parasols-et-abris": "https://images.unsplash.com/photo-1527359443443-84a48aec73d2?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "bbq-et-articles-de-cuisson-exterieurs": "https://images.unsplash.com/photo-1534177616072-ef7dc120449d?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "salon": "https://images.unsplash.com/photo-1484101403633-562f891dc89a?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "chambre-a-coucher": "https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "cuisine-et-salle-a-manger": "https://images.unsplash.com/photo-1593136596203-7212b076f4d2?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "bureau": "https://images.unsplash.com/photo-1493934558415-9d19f0b2b4d2?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "chiens": "https://images.unsplash.com/photo-1696348376202-a36b0bc95e0f?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "chats": "https://images.unsplash.com/photo-1772106762705-cd286a695f86?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "accessoires-pour-animaux": "https://images.unsplash.com/photo-1581888227599-779811939961?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "jouets-pour-enfants": "https://images.unsplash.com/photo-1545558014-8692077e9b5c?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
  "meubles-pour-enfants": "https://images.unsplash.com/photo-1721395288477-b546804ce392?ixlib=rb-4.1.0&w=440&h=300&fit=crop&crop=entropy&q=80",
};

const NEEDED = ["rabais", "mobiliers-exterieurs-et-jardins", "meubles-et-decorations",
  "ensembles-de-patio", "chaises-et-tables-de-patio-1", "gazebos-parasols-et-abris",
  "bbq-et-articles-de-cuisson-exterieurs", "salon", "chambre-a-coucher",
  "cuisine-et-salle-a-manger", "bureau", "accessoires-pour-animaux", "chiens", "chats",
  "jouets-pour-enfants", "meubles-pour-enfants", "jardinage-et-serres", "coups-de-coeur"];

// resolve gids
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
  { title: "Animaux", ...col("accessoires-pour-animaux"), items: [
    { title: "Chiens", ...col("chiens") },
    { title: "Chats", ...col("chats") },
    { title: "Accessoires", ...col("accessoires-pour-animaux") },
  ] },
  { title: "Enfants", ...col("jouets-pour-enfants"), items: [
    { title: "Jouets pour enfants", ...col("jouets-pour-enfants") },
    { title: "Meubles pour enfants", ...col("meubles-pour-enfants") },
  ] },
  { title: "Jardin", ...col("jardinage-et-serres") },
  { title: "Coups de cœur", ...col("coups-de-coeur") },
  { title: "Catalogue", type: "CATALOG" },
];

const existing = await gql(`{ menus(first:50){ nodes{ id handle } } }`);
const found = existing.data.menus.nodes.find((m) => m.handle === MENU_HANDLE);
if (found) {
  const r = await gql(`mutation($id:ID!,$title:String!,$items:[MenuItemUpdateInput!]!){ menuUpdate(id:$id,title:$title,items:$items){ menu{handle} userErrors{field message} } }`, { id: found.id, title: "Menu preview (premium)", items });
  if (r.data.menuUpdate.userErrors.length) throw new Error("menuUpdate: " + JSON.stringify(r.data.menuUpdate.userErrors));
  console.log(`✔ menuUpdate ${MENU_HANDLE} (8 top items)`);
} else {
  const r = await gql(`mutation($title:String!,$handle:String!,$items:[MenuItemCreateInput!]!){ menuCreate(title:$title,handle:$handle,items:$items){ menu{handle} userErrors{field message} } }`, { title: "Menu preview (premium)", handle: MENU_HANDLE, items });
  if (r.data.menuCreate.userErrors.length) throw new Error("menuCreate: " + JSON.stringify(r.data.menuCreate.userErrors));
  console.log(`✔ menuCreate ${MENU_HANDLE}`);
}

// mega-menu.liquid (image cards keyed by collection handle in the url)
const cases = Object.entries(IMG).map(([h, u]) => `      {%- when '${h}' -%}{%- assign img = '${u}' -%}`).join("\n");
const megaSnippet = `{% comment %}
  Premium mega-menu panel — image card per sub-category, image resolved from the
  collection handle in each child link's URL. Render: {% render 'mega-menu', link: link %}
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
  .lc-mega-card{display:block;text-decoration:none;color:#1B2A4A;position:relative}
  .lc-mega-img{display:block;width:100%;aspect-ratio:4/3;border-radius:10px;background-size:cover;background-position:center;box-shadow:0 2px 10px rgba(27,42,74,.12);transition:transform .2s ease,box-shadow .2s ease}
  .lc-mega-img::after{content:'';position:absolute;inset:0;border-radius:10px;background:rgba(27,42,74,.34);transition:background .2s ease}
  .lc-mega-img--ph{background:#ECE7E1}
  .lc-mega-card:hover .lc-mega-img{transform:scale(1.02);box-shadow:0 10px 24px rgba(27,42,74,.22)}
  .lc-mega-card:hover .lc-mega-img::after{background:rgba(27,42,74,.18)}
  .lc-mega-name{display:block;margin-top:.55rem;font-size:1.4rem;font-weight:700}
  .lc-mega-card:hover .lc-mega-name{color:#C17F3E}
  .lc-mega-all{grid-column:1 / -1;justify-self:start;margin-top:.3rem;font-weight:700;font-size:1.35rem;color:#C17F3E;text-decoration:none}
  .lc-mega-all:hover{text-decoration:underline}
  @media(max-width:989px){.lc-mega{grid-template-columns:repeat(2,1fr)}}
</style>
`;
console.log(`✔ PUT snippets/mega-menu.liquid → ${await putAsset("snippets/mega-menu.liquid", megaSnippet)}`);

// header-mega-menu.liquid delegates the mega panel to mega-menu.liquid
const headerMega = `{% comment %} Header menu; mega panels delegate to 'mega-menu'. {% endcomment %}
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
console.log(`✔ PUT snippets/header-mega-menu.liquid → ${await putAsset("snippets/header-mega-menu.liquid", headerMega)}`);

// header points at preview-main-menu, mega type
const hg = JSON.parse(await getAsset("sections/header-group.json"));
hg.sections.header.settings.menu = MENU_HANDLE;
hg.sections.header.settings.menu_type_desktop = "mega";
console.log(`✔ PUT sections/header-group.json → ${await putAsset("sections/header-group.json", JSON.stringify(hg, null, 2))}`);

console.log(`\nDone on PREVIEW ${THEME}. Live untouched (separate menu). Preview: https://27u5y2-kp.myshopify.com/?preview_theme_id=${THEME}`);
