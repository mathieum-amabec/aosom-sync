// "Voyez-le chez vous" — dedicated page on the PREVIEW theme (live untouched; guarded).
//
// Idempotent. Does three things:
//   ÉTAPE 2 — ensure the Shopify page (handle voyez-le-chez-vous, template_suffix voyez-le, published)
//   ÉTAPE 3 — PUT sections/page-voyez-le.liquid + templates/page.voyez-le.json on PREVIEW (200)
//   ÉTAPE 4 — append "Voyez-le chez vous" → page into preview-main-menu via menuUpdate
//
// Cards = every product with a READY video in video_ingest_log (Turso), published on the
// Online Store. Live data (url/title/price/poster) resolved at render via all_products[handle];
// the source video URL + category are baked. Hover-to-play on desktop, autoplay-in-view on mobile.
import { loadEnv, gql, rest, getAsset, putAsset, sleep } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const LIVE = "160059195497";
const PREVIEW = "160213696617";
const MENU_HANDLE = "preview-main-menu";
const PAGE_HANDLE = "voyez-le-chez-vous";
const TEMPLATE_SUFFIX = "voyez-le";

if (PREVIEW === LIVE) throw new Error("ABORT: preview === live");
const theme = (await (await rest("/themes.json")).json()).themes.find((t) => String(t.id) === PREVIEW);
if (!theme || theme.role !== "unpublished") throw new Error(`ABORT: theme ${PREVIEW} is not an unpublished preview`);
console.log(`Target theme: ${theme.id} "${theme.name}" [${theme.role}]`);

// ── gather video products ────────────────────────────────────────────────────
const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const ready = await db.execute(`SELECT product_id, MIN(sku) sku, MIN(video_url) video_url
  FROM video_ingest_log WHERE status='READY' GROUP BY product_id ORDER BY MIN(sku)`);

const Q = `query($id:ID!){ product(id:$id){ handle title productType publishedAt
  collections(first:25){ nodes{ handle } } } }`;

function categorize(type, cols) {
  if (cols.includes("jardinage-et-serres")) return "jardin";
  if (/Lawn & Garden/i.test(type)) return "jardin";
  if (/^Pet Supplies/i.test(type)) return "jardin"; // outdoor coops/enclosures
  if (/^Home Furnishings/i.test(type) || cols.includes("meubles-et-decorations")) return "meubles";
  return "patio"; // patio furniture, shade, swings, gazebo, recreation
}

const cards = [];
let skippedUnpublished = 0;
for (const row of ready.rows) {
  const { data } = await gql(Q, { id: String(row.product_id) });
  const p = data.product;
  if (!p) continue;
  if (!p.publishedAt) { skippedUnpublished++; continue; } // not on Online Store → all_products[] is blank
  const cols = p.collections.nodes.map((c) => c.handle);
  cards.push({ handle: p.handle, video: String(row.video_url), cat: categorize(p.productType || "", cols), sku: row.sku });
}
const ORDER = { patio: 0, jardin: 1, meubles: 2 };
cards.sort((a, b) => (ORDER[a.cat] - ORDER[b.cat]) || String(a.sku).localeCompare(String(b.sku)));
const counts = cards.reduce((m, c) => ((m[c.cat] = (m[c.cat] || 0) + 1), m), {});
console.log(`Cards: ${cards.length} published (skipped ${skippedUnpublished} unpublished). By category:`, counts);
if (!cards.length) throw new Error("ABORT: no published video products");

// ── ÉTAPE 3a — sections/page-voyez-le.liquid ─────────────────────────────────
const cardLiquid = cards.map((c) => `        {%- assign p = all_products['${c.handle}'] -%}
        {%- if p != blank -%}
        <article class="vl-card" data-cat="${c.cat}">
          <a class="vl-media" href="{{ p.url }}" aria-label="{{ p.title | escape }}" data-umami-event="Voyez-le {{ p.title | escape }}">
            <video class="vl-vid" muted loop playsinline preload="none"{% if p.featured_image %} poster="{{ p.featured_image | image_url: width: 640 }}"{% endif %}>
              <source data-src="${c.video}" type="video/mp4">
            </video>
          </a>
          <div class="vl-body">
            <a class="vl-title" href="{{ p.url }}">{{ p.title | escape }}</a>
            <span class="vl-price">{{ p.price | money }}</span>
            <a class="vl-btn" href="{{ p.url }}">{% if loc == 'en' %}View product{% else %}Voir le produit{% endif %}</a>
          </div>
        </article>
        {%- endif -%}`).join("\n");

const SECTION = `{%- assign loc = request.locale.iso_code | downcase -%}
<section class="vl-wrap">
  <header class="vl-hero">
    <div class="page-width">
      <h1 class="vl-hero-title">{% if loc == 'en' %}See it at home{% else %}Voyez-le chez vous{% endif %}</h1>
      <p class="vl-hero-sub">{% if loc == 'en' %}Watch our products in motion before you buy — real videos for every item.{% else %}Voyez nos produits en action avant d'acheter — une vidéo pour chaque article.{% endif %}</p>
    </div>
  </header>

  <div class="page-width vl-inner">
    <div class="vl-filters" role="group" aria-label="{% if loc == 'en' %}Filter by category{% else %}Filtrer par catégorie{% endif %}">
      <button type="button" class="vl-filter is-active" data-filter="all">{% if loc == 'en' %}All{% else %}Tous{% endif %}</button>
      <button type="button" class="vl-filter" data-filter="patio">Patio</button>
      <button type="button" class="vl-filter" data-filter="meubles">{% if loc == 'en' %}Furniture{% else %}Meubles{% endif %}</button>
      <button type="button" class="vl-filter" data-filter="jardin">{% if loc == 'en' %}Garden{% else %}Jardin{% endif %}</button>
    </div>

    <div class="vl-grid">
${cardLiquid}
    </div>
    <p class="vl-empty" hidden>{% if loc == 'en' %}No products in this category.{% else %}Aucun produit dans cette catégorie.{% endif %}</p>
  </div>
</section>

<style>
  .vl-wrap{--navy:#1B2A4A;--gold:#D4A853;background:#FAFAF8;font-family:'DM Sans',sans-serif}
  .vl-hero{background:var(--navy);color:#fff;text-align:center;padding:56px 0 50px}
  .vl-hero-title{font-weight:700;font-size:clamp(2.2rem,4.5vw,3.4rem);margin:0 0 .5rem;color:#fff;letter-spacing:-.01em}
  .vl-hero-sub{font-size:clamp(1.4rem,2vw,1.7rem);color:#cdd4e3;margin:0;max-width:46ch;margin-inline:auto;line-height:1.45}
  .vl-inner{padding:36px 0 64px}
  .vl-filters{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin:0 0 32px}
  .vl-filter{appearance:none;border:1.5px solid #d7d2c8;background:#fff;color:var(--navy);font-family:inherit;font-weight:600;font-size:1.35rem;padding:9px 22px;border-radius:999px;cursor:pointer;transition:all .18s ease}
  .vl-filter:hover{border-color:var(--navy)}
  .vl-filter.is-active{background:var(--navy);border-color:var(--navy);color:#fff}
  .vl-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
  .vl-card{display:flex;flex-direction:column;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(27,42,74,.08);transition:transform .2s ease,box-shadow .2s ease}
  .vl-card:hover{transform:translateY(-3px);box-shadow:0 12px 28px rgba(27,42,74,.16)}
  .vl-media{display:block;position:relative;aspect-ratio:4/3;background:var(--navy);overflow:hidden}
  .vl-vid{width:100%;height:100%;object-fit:cover;display:block}
  .vl-body{display:flex;flex-direction:column;gap:8px;padding:16px 18px 18px}
  .vl-title{color:var(--navy);font-weight:700;font-size:1.45rem;line-height:1.3;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
  .vl-title:hover{color:#C17F3E}
  .vl-price{color:var(--navy);font-weight:700;font-size:1.5rem}
  .vl-btn{margin-top:4px;align-self:flex-start;background:var(--navy);color:#fff;font-weight:700;font-size:1.3rem;text-decoration:none;padding:10px 20px;border-radius:8px;transition:background .18s ease}
  .vl-btn:hover{background:var(--gold);color:var(--navy)}
  .vl-empty{text-align:center;color:#5b6172;font-size:1.5rem;padding:40px 0}
  @media(max-width:989px){.vl-grid{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:600px){.vl-grid{grid-template-columns:1fr;gap:18px}}
</style>

<script>
  (function(){
    var root=document.querySelector('.vl-wrap');
    if(!root) return;
    var hover=window.matchMedia('(hover:hover) and (pointer:fine)').matches;
    function lazy(v){ var s=v.querySelector('source[data-src]'); if(s&&!s.src){ s.src=s.getAttribute('data-src'); v.load(); } }
    function play(v){ lazy(v); var pr=v.play(); if(pr&&pr.catch)pr.catch(function(){}); }
    var vids=root.querySelectorAll('.vl-vid');
    if(hover){
      root.querySelectorAll('.vl-card').forEach(function(card){
        var v=card.querySelector('.vl-vid'); if(!v) return;
        card.addEventListener('mouseenter',function(){ play(v); });
        card.addEventListener('mouseleave',function(){ v.pause(); });
      });
    } else if('IntersectionObserver' in window){
      var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting) play(e.target); else e.target.pause(); }); },{threshold:0.4});
      vids.forEach(function(v){ io.observe(v); });
    } else {
      vids.forEach(play);
    }
    var empty=root.querySelector('.vl-empty');
    root.querySelectorAll('.vl-filter').forEach(function(btn){
      btn.addEventListener('click',function(){
        var f=btn.getAttribute('data-filter'), shown=0;
        root.querySelectorAll('.vl-filter').forEach(function(b){ b.classList.toggle('is-active', b===btn); });
        root.querySelectorAll('.vl-card').forEach(function(c){
          var show = f==='all' || c.getAttribute('data-cat')===f;
          c.hidden=!show; if(show) shown++;
        });
        if(empty) empty.hidden = shown!==0;
      });
    });
  })();
</script>

{% schema %}
{"name":"Page Voyez-le","tag":"section","class":"section","settings":[],"presets":[{"name":"Page Voyez-le"}]}
{% endschema %}`;

console.log(`✔ PUT sections/page-voyez-le.liquid → ${(await putAsset("sections/page-voyez-le.liquid", SECTION, PREVIEW)) && 200}`);
await sleep(550);

// ── ÉTAPE 3b — templates/page.voyez-le.json ──────────────────────────────────
const tpl = { sections: { main: { type: "page-voyez-le", settings: {} } }, order: ["main"] };
console.log(`✔ PUT templates/page.voyez-le.json → ${(await putAsset("templates/page.voyez-le.json", JSON.stringify(tpl, null, 2), PREVIEW)) && 200}`);
await sleep(550);

// ── ÉTAPE 2 — Shopify page (create or update; published, template_suffix voyez-le) ──
const allPages = (await (await rest("/pages.json?limit=250")).json()).pages || [];
let page = allPages.find((p) => p.handle === PAGE_HANDLE);
const pageBody = { title: "Voyez-le chez vous", handle: PAGE_HANDLE, published: true, template_suffix: TEMPLATE_SUFFIX };
if (page) {
  const r = await rest(`/pages/${page.id}.json`, { method: "PUT", body: JSON.stringify({ page: { id: page.id, ...pageBody } }) });
  if (!r.ok) throw new Error(`page update failed: ${r.status} ${await r.text()}`);
  page = (await r.json()).page;
  console.log(`✔ page updated → id ${page.id} /pages/${page.handle} [suffix:${page.template_suffix}, published:${!!page.published_at}]`);
} else {
  const r = await rest(`/pages.json`, { method: "POST", body: JSON.stringify({ page: pageBody }) });
  if (!r.ok) throw new Error(`page create failed: ${r.status} ${await r.text()}`);
  page = (await r.json()).page;
  console.log(`✔ page created → id ${page.id} /pages/${page.handle} [suffix:${page.template_suffix}, published:${!!page.published_at}]`);
}
const pageGid = `gid://shopify/Page/${page.id}`;

// ── ÉTAPE 4 — menuUpdate: append page link to preview-main-menu ───────────────
const md = await gql(`{ menus(first:50){ nodes{ id handle title items{
  id title type resourceId url
  items{ id title type resourceId url items{ id title type resourceId url } } } } } }`);
const menu = md.data.menus.nodes.find((m) => m.handle === MENU_HANDLE);
if (!menu) throw new Error(`ABORT: menu ${MENU_HANDLE} not found`);

const toInput = (it) => {
  const o = { id: it.id, title: it.title, type: it.type };
  if (it.resourceId) o.resourceId = it.resourceId;
  if ((it.type === "HTTP" || it.type === "FRONTEND_LINK") && it.url) o.url = it.url;
  if (it.items && it.items.length) o.items = it.items.map(toInput);
  return o;
};
let items = menu.items.map(toInput);
// drop any prior copy of our link (idempotent re-run), then insert after "Coups de cœur"
items = items.filter((it) => !(it.type === "PAGE" && it.resourceId === pageGid) && it.title !== "Voyez-le chez vous");
const newItem = { title: "Voyez-le chez vous", type: "PAGE", resourceId: pageGid };
const idx = items.findIndex((it) => /coups de c/i.test(it.title));
if (idx >= 0) items.splice(idx + 1, 0, newItem); else items.push(newItem);

const mu = await gql(
  `mutation($id:ID!,$title:String!,$items:[MenuItemUpdateInput!]!){ menuUpdate(id:$id,title:$title,items:$items){ menu{ handle items{ title type url } } userErrors{ field message } } }`,
  { id: menu.id, title: menu.title, items }
);
if (mu.data.menuUpdate.userErrors.length) throw new Error("menuUpdate: " + JSON.stringify(mu.data.menuUpdate.userErrors));
const topTitles = mu.data.menuUpdate.menu.items.map((i) => i.title);
console.log(`✔ menuUpdate ${MENU_HANDLE} → ${topTitles.length} top items: ${topTitles.join(" · ")}`);

console.log(`\nDone on PREVIEW ${PREVIEW}. Live untouched.`);
console.log(`Preview page: https://${"27u5y2-kp.myshopify.com"}/pages/${PAGE_HANDLE}?preview_theme_id=${PREVIEW}`);
