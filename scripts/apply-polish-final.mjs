// Final homepage polish on PREVIEW 160213696617 (live untouched; guarded).
import { rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";
const LIVE = LIVE_THEME_ID, PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");
console.log(`Target: ${t.id} "${t.name}" [${t.role}]`);
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));

const SVG = (inner) => `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1B2A4A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICO_GRID = SVG('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>');
const ICO_TRUCK = SVG('<path d="M1 4h13v11H1z"/><path d="M14 7h4l3 3v5h-7z"/><circle cx="5.5" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>');
const ICO_RETURN = SVG('<path d="M3 8V3"/><path d="M3 8h5"/><path d="M3.6 8a9 9 0 1 1-1.1 6.4"/>');
const ICO_LEAF = SVG('<path d="M11 21c5-1 9-6 9-13V4h-4C9 4 4 9 4 16c0 2 1 4 1 4"/><path d="M5 20c3-6 7-9 12-10"/>');
const col = (ico, h, p) => `<div class="lc-why-col"><div class="lc-why-ico" style="height:40px;display:flex;align-items:center;justify-content:center;margin-bottom:.6rem">${ico}</div><h3 style="font-size:1.5rem;margin:0 0 .25rem;color:#1A1A2E">${h}</h3><p style="font-size:1.3rem;margin:0;color:#797068">${p}</p></div>`;

// 1. why_us premium (FR-only, #FAFAF8 bg)
idx.sections.why_us.settings.custom_liquid =
  `<div class="lc-why-wrap" style="background:#FAFAF8;padding:44px 0"><div class="page-width lc-why"><div class="lc-why-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px;text-align:center">` +
  col(ICO_GRID, "Catalogue de 490+ produits", "Meubles, extérieur, jardin et animaux") +
  col(ICO_TRUCK, "Livraison gratuite au Canada", "Aucuns frais, partout au pays") +
  col(ICO_RETURN, "Retours faciles 30 jours", "Changez d'avis sans souci") +
  col(ICO_LEAF, "Service client québécois", "Une équipe humaine, locale") +
  `</div></div></div><style>.lc-why-ico svg{display:block}@media(max-width:749px){.lc-why-grid{grid-template-columns:repeat(2,1fr);gap:20px}}</style>`;
console.log("1. why_us rebuilt (4 points, #FAFAF8)");

// 2. lc_trustbar: drop the "Livraison gratuite" span
const tb = idx.sections.lc_trustbar.settings;
const SPAN = `<span style="white-space:nowrap">{% if loc == 'en' %}✓ Free shipping{% else %}✓ Livraison gratuite{% endif %}</span>`;
if (!tb.custom_liquid.includes(SPAN)) throw new Error("ABORT: trustbar span not found");
tb.custom_liquid = tb.custom_liquid.replace(SPAN, "");
console.log("2. lc_trustbar: 'Livraison gratuite' span removed");

// 3. remove rich_text (CAPS + redundant)
if (idx.sections.rich_text) { delete idx.sections.rich_text; idx.order = idx.order.filter((k) => k !== "rich_text"); console.log("3. rich_text removed"); }

// 4. featured_sale: drop emoji from title
idx.sections.featured_sale.settings.title = idx.sections.featured_sale.settings.title.replace(/^🔥\s*/, "");
console.log("4. featured_sale title:", idx.sections.featured_sale.settings.title);

// 5. entry popup
const POPUP = `{%- assign loc = request.locale.iso_code | downcase -%}
<div id="lc-pop" class="lc-pop" role="dialog" aria-modal="true" aria-hidden="true" aria-label="{% if loc == 'en' %}First order discount{% else %}Rabais premiere commande{% endif %}">
  <div class="lc-pop__ov" data-pop-close></div>
  <div class="lc-pop__card">
    <button class="lc-pop__x" type="button" data-pop-close aria-label="{% if loc == 'en' %}Close{% else %}Fermer{% endif %}">&times;</button>
    <div class="lc-pop__inner">
      <span class="lc-pop__badge">10%</span>
      <h2 class="lc-pop__title">{% if loc == 'en' %}Get 10% off your first order{% else %}Obtenez 10% sur votre premiere commande{% endif %}</h2>
      <p class="lc-pop__sub">{% if loc == 'en' %}Sign up and receive your code by email.{% else %}Inscrivez-vous et recevez votre code par courriel.{% endif %}</p>
      {%- form 'customer', class: 'lc-pop__form', novalidate: 'novalidate' -%}
        <input type="hidden" name="contact[tags]" value="newsletter, popup-10off">
        <input class="lc-pop__email" type="email" name="contact[email]" required autocomplete="email" placeholder="{% if loc == 'en' %}your@email.com{% else %}votre@courriel.com{% endif %}">
        <button class="lc-pop__btn" type="submit">{% if loc == 'en' %}Get my discount{% else %}Je veux mon rabais{% endif %}</button>
        <p class="lc-pop__msg" role="alert" hidden></p>
      {%- endform -%}
      <div class="lc-pop__ok" hidden><p>{% if loc == 'en' %}Check your email for your 10% code!{% else %}Verifiez votre courriel pour votre code 10%!{% endif %}</p></div>
    </div>
  </div>
</div>
<style>
.lc-pop{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:16px;font-family:'DM Sans',sans-serif}
.lc-pop.is-open{display:flex}
.lc-pop__ov{position:absolute;inset:0;background:rgba(26,26,46,.55)}
.lc-pop__card{position:relative;background:#fff;border-radius:14px;max-width:420px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:lc-pop-in .3s ease both}
@keyframes lc-pop-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.lc-pop__x{position:absolute;top:6px;right:12px;background:none;border:0;font-size:30px;line-height:1;color:#fff;cursor:pointer;z-index:2;opacity:.85}
.lc-pop__x:hover{opacity:1}
.lc-pop__inner::before{content:'';display:block;height:88px;background:#1B2A4A}
.lc-pop__badge{position:absolute;top:54px;left:50%;transform:translateX(-50%);width:68px;height:68px;border-radius:50%;background:#D4A853;color:#1B2A4A;font-weight:700;font-size:1.9rem;display:flex;align-items:center;justify-content:center;border:4px solid #fff}
.lc-pop__title{margin:46px 24px 6px;text-align:center;font-size:1.9rem;font-weight:700;color:#1B2A4A;line-height:1.2}
.lc-pop__sub{margin:0 24px 18px;text-align:center;font-size:1.4rem;color:#5b6172}
.lc-pop__form{margin:0 24px 24px;display:flex;flex-direction:column;gap:10px}
.lc-pop__email{padding:12px 14px;border:1px solid #d9d2c7;border-radius:8px;font-size:1.5rem;font-family:inherit}
.lc-pop__email:focus{outline:2px solid #C17F3E;outline-offset:0;border-color:#C17F3E}
.lc-pop__btn{padding:13px;background:#1B2A4A;color:#fff;border:0;border-radius:8px;font-weight:700;font-size:1.5rem;cursor:pointer;font-family:inherit}
.lc-pop__btn:hover{background:#C17F3E}
.lc-pop__btn:disabled{opacity:.7;cursor:default}
.lc-pop__msg{margin:0;font-size:1.3rem;color:#c0392b;text-align:center}
.lc-pop__ok{padding:0 24px 26px;text-align:center;font-size:1.5rem;color:#1B2A4A;font-weight:600}
@media(max-width:749px){.lc-pop__card{max-width:none}.lc-pop__title{font-size:1.7rem}}
</style>
<script>
(function(){
  var KEY='lc_pop_seen_v1';
  try{ if(localStorage.getItem(KEY)) return; }catch(e){}
  var pop=document.getElementById('lc-pop'); if(!pop) return;
  var shown=false, timer;
  function show(){ if(shown) return; shown=true; pop.classList.add('is-open'); pop.setAttribute('aria-hidden','false'); try{localStorage.setItem(KEY,'1');}catch(e){} clearTimeout(timer); window.removeEventListener('scroll',onScroll); }
  function close(){ pop.classList.remove('is-open'); pop.setAttribute('aria-hidden','true'); }
  function onScroll(){ var sc=window.scrollY||document.documentElement.scrollTop; var h=document.documentElement.scrollHeight-window.innerHeight; if(h>0 && sc/h>=0.5) show(); }
  timer=setTimeout(show,5000);
  window.addEventListener('scroll',onScroll,{passive:true});
  pop.addEventListener('click',function(e){ if(e.target.closest('[data-pop-close]')) close(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
  var form=pop.querySelector('.lc-pop__form');
  if(form) form.addEventListener('submit',function(e){
    e.preventDefault();
    var email=form.querySelector('.lc-pop__email'); var msg=form.querySelector('.lc-pop__msg');
    var re=/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
    if(!re.test((email.value||'').trim())){ msg.hidden=false; msg.textContent="{% if loc == 'en' %}Please enter a valid email.{% else %}Entrez un courriel valide.{% endif %}"; return; }
    var btn=form.querySelector('.lc-pop__btn'); btn.disabled=true;
    fetch(form.action,{method:'POST',body:new FormData(form),headers:{'Accept':'text/html'}})
      .then(function(){ done(); }).catch(function(){ done(); });
    function done(){ form.hidden=true; pop.querySelector('.lc-pop__ok').hidden=false; }
  });
})();
</script>`;
idx.sections.entry_popup = { type: "custom-liquid", settings: { custom_liquid: POPUP, color_scheme: "", padding_top: 0, padding_bottom: 0 } };
if (!idx.order.includes("entry_popup")) idx.order.push("entry_popup");
console.log("5. entry_popup added");

await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW);
console.log("\nindex.json PUT 200. order:", idx.order.join(", "));
