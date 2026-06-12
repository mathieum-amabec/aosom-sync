// feature/video-section-fix — reposition "Voyez-le chez vous" + desktop hover-to-play perf fix.
// PREVIEW theme only (160213696617). Live (160059195497 / role:main) is guarded and untouched.
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT: preview === live");

const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t) throw new Error("ABORT: preview theme not found");
if (t.role !== "unpublished") throw new Error(`ABORT: target role is '${t.role}', expected 'unpublished'`);
console.log(`Target: ${t.id} "${t.name}" [${t.role}]`);

// Same 6 products/videos. Desktop shows first 4 (CSS), mobile shows all 6.
const cards = [
  ["gazebo-outsunny-3x3m-toit-rigide-polycarbonate-avec-rideaux-gris-fonce", "https://uspm.aosomcdn.com/videos/en/8/84C-546V00CG/84C-546V00CG-Outsunny-WEB.mp4"],
  ["ensemble-de-patio-en-acier-5-pieces-avec-table-en-verre-trempe", "https://uspm.aosomcdn.com/videos/en/8/84G-683V00BK/84G-683V00BK-Outsunny-WEB.mp4"],
  ["ensemble-de-patio-outsunny-4-pieces-en-rotin-avec-causeuse-et-table-beige", "https://uspm.aosomcdn.com/videos/en/8/860-394V00BG/860-394V00BG-Outsunny-WEB.mp4"],
  ["ensemble-4-chaises-salle-a-manger-aosom-rembourrees-pieds-metal", "https://uspm.aosomcdn.com/videos/en/8/83A-212V02BK/83A-212V02BK-HOMCOM-WEB.mp4"],
  ["poussette-pliable-aosom-pour-grands-chiens-avec-4-roues-et-amortisseurs", "https://uspm.aosomcdn.com/videos/en/D/D00-210V00CG/D00-210V00CG-PawHut-WEB.mp4"],
  ["classeur-2-tiroirs-verrouillable-aosom-avec-barre-ajustable", "https://uspm.aosomcdn.com/videos/en/9/924-077V80GY/924-077V80GY-HOMCOM-WEB.mp4"],
];
const cardLiquid = cards.map(([h, v]) => `      {%- assign p = all_products['${h}'] -%}
      {%- if p != blank -%}
        <a class="hv-card" href="{{ p.url }}" data-umami-event="Home video {{ p.title | escape }}">
          <video class="hv-vid" muted loop playsinline preload="none" poster="{% if p.featured_image %}{{ p.featured_image | image_url: width: 640 }}{% endif %}"><source data-src="${v}" type="video/mp4"></video>
          <span class="hv-ov"><span class="hv-t">{{ p.title | escape }}</span><span class="hv-p">{{ p.price | money }}</span></span>
        </a>
      {%- endif -%}`).join("\n");

const SECTION = `{%- assign loc = request.locale.iso_code | downcase -%}
<div class="hv-wrap" style="background:#FAFAF8">
  <div class="page-width hv-inner">
    <h2 class="hv-h">{% if loc == 'en' %}See it at home{% else %}Voyez-le chez vous{% endif %}</h2>
    <p class="hv-sub">{% if loc == 'en' %}Discover our products in real living spaces{% else %}Découvrez nos produits dans de vrais espaces de vie{% endif %}</p>
    <div class="hv-grid">
${cardLiquid}
    </div>
  </div>
</div>
<style>
  .hv-wrap{padding:52px 0}
  .hv-h{font-family:'DM Sans',sans-serif;font-weight:700;color:#1B2A4A;text-align:center;font-size:clamp(2rem,3.5vw,2.6rem);margin:0 0 .4rem}
  .hv-sub{text-align:center;color:#5b6172;font-size:1.5rem;margin:0 0 2rem}
  .hv-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
  .hv-card{position:relative;display:block;border-radius:12px;overflow:hidden;text-decoration:none;background:#1B2A4A;aspect-ratio:4/3}
  .hv-vid{width:100%;height:100%;object-fit:cover;display:block}
  .hv-ov{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:2px;padding:14px 16px;background:linear-gradient(to top,rgba(27,42,74,.92),rgba(27,42,74,.55) 60%,transparent);opacity:0;transition:opacity .25s ease;font-family:'DM Sans',sans-serif}
  .hv-card:hover .hv-ov,.hv-card:focus-within .hv-ov{opacity:1}
  .hv-t{color:#fff;font-weight:700;font-size:1.45rem;line-height:1.25}
  .hv-p{color:#D4A853;font-weight:700;font-size:1.4rem}
  /* Desktop (>=750px): 4 cards in one row; video plays on hover only (static poster otherwise) */
  @media(min-width:750px){.hv-card:nth-child(n+5){display:none}}
  /* Mobile (<750px): all 6 cards, autoplay muted loop, overlay always visible */
  @media(max-width:749px){.hv-grid{grid-template-columns:repeat(2,1fr)}.hv-ov{opacity:1}}
  @media(max-width:480px){.hv-grid{grid-template-columns:1fr}}
</style>
<script>
  (function(){
    var cards=[].slice.call(document.querySelectorAll('.hv-card'));
    if(!cards.length) return;
    function load(v){ var s=v.querySelector('source[data-src]'); if(s && !s.src){ s.src=s.getAttribute('data-src'); v.load(); } }
    function play(v){ var pr=v.play(); if(pr&&pr.catch)pr.catch(function(){}); }
    // Gate on input capability, not viewport width: hover + fine pointer (mouse/trackpad)
    // = desktop hover-to-play; touch devices (incl. tablets >=750px) fall through to autoplay.
    // This is resize-proof (capability doesn't change with width) and fixes touch tablets
    // where width-based gating left mouseenter firing without mouseleave (video stuck playing).
    var canHover = window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches;
    if(canHover){
      // Desktop/mouse: static poster, load + play on hover/focus only — no upfront video fetch.
      cards.forEach(function(card){
        var v=card.querySelector('.hv-vid'); if(!v || v.__hvBound) return; v.__hvBound=1;
        function start(){ load(v); play(v); }
        function stop(){ v.pause(); }
        card.addEventListener('mouseenter',start);
        card.addEventListener('mouseleave',stop);
        card.addEventListener('focus',start,true);
        card.addEventListener('blur',stop,true);
      });
    } else {
      // Mobile: autoplay muted loop for visible videos.
      var vids=[].slice.call(document.querySelectorAll('.hv-vid'));
      function activate(v){ load(v); play(v); }
      if(!('IntersectionObserver' in window)){ vids.forEach(activate); return; }
      var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ activate(e.target); } else { e.target.pause(); } }); },{threshold:0.25});
      vids.forEach(function(v){ io.observe(v); });
    }
  })();
</script>
{% schema %}
{"name":"Vidéos accueil","tag":"section","class":"section","settings":[],"presets":[{"name":"Vidéos accueil"}]}
{% endschema %}`;

await putAsset("sections/home-video-showcase.liquid", SECTION, PREVIEW);
console.log("PUT sections/home-video-showcase.liquid -> 200");

// Reposition home_video: right after shop_pay_home, before the product carousels (featured_sale / featured_collection2).
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
idx.sections.home_video = idx.sections.home_video || { type: "home-video-showcase", settings: {} };
idx.order = idx.order.filter((id) => id !== "home_video");
const anchor = idx.order.indexOf("shop_pay_home");
if (anchor >= 0) idx.order.splice(anchor + 1, 0, "home_video");
else {
  // Fallback: place before the first featured-collection carousel.
  const fc = idx.order.findIndex((id) => idx.sections[id] && idx.sections[id].type === "featured-collection");
  if (fc >= 0) idx.order.splice(fc, 0, "home_video");
  else idx.order.push("home_video");
}
await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW);
console.log("PUT templates/index.json -> 200");
console.log("order:", idx.order.join(", "));
