// Surgical: rewrite only lc_loop.custom_liquid with selectors that match Shopify's
// real DOM ids (sections in JSON templates render as id="shopify-section-template--<pageid>__<sectionId>").
import { getAsset, putAsset } from "./_shopify-lib.mjs";

const idx = JSON.parse(await getAsset("templates/index.json"));

const loopLiquid =
  `<style>.slider-counter{display:none!important}` +
  // Free-scroll (no snap) + instant programmatic scroll so the wrap jump is seamless.
  `[id$="__featured_collection1"] ul.slider,[id$="__featured_collection2"] ul.slider,[id$="__featured_sale"] ul.slider{scroll-snap-type:none!important;scroll-behavior:auto!important}` +
  `</style>` +
  `<script>(function(){` +
  `function setup(ul){if(!ul||ul.dataset.loopInit)return;` +
  `var items=Array.prototype.slice.call(ul.children);if(items.length<2)return;` +
  `ul.dataset.loopInit='1';var n=items.length;` +
  `items.forEach(function(li){var c=li.cloneNode(true);c.setAttribute('aria-hidden','true');c.setAttribute('data-loop-clone','1');` +
  `c.querySelectorAll('[id]').forEach(function(e){e.removeAttribute('id');});ul.appendChild(c);});` +
  `function span(){return ul.children[n].offsetLeft-ul.children[0].offsetLeft;}` +
  `var jumping=false;` +
  `ul.addEventListener('scroll',function(){if(jumping)return;var s=span();if(s>0&&ul.scrollLeft>=s){jumping=true;ul.scrollLeft-=s;jumping=false;}},{passive:true});}` +
  `function sec(sfx){return document.querySelector('[id^="shopify-section-"][id$="__'+sfx+'"]')||document.getElementById('shopify-section-'+sfx);}` +
  `function init(){['featured_collection1','featured_collection2','featured_sale'].forEach(function(sfx){` +
  `var s=sec(sfx);if(!s)return;var ul=s.querySelector('ul.slider')||s.querySelector('.slider');if(ul)setup(ul);});}` +
  `if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);` +
  `})();</script>`;

idx.sections.lc_loop.settings.custom_liquid = loopLiquid;
await putAsset("templates/index.json", JSON.stringify(idx, null, 2));
console.log("✓ lc_loop injector updated (suffix-matched selectors + global slider-counter hide)");
