// CHANTIER 2 — color swatches on the PDP variant picker (PREVIEW only).
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");

let mp = await getAsset("sections/main-product.liquid", PREVIEW);
const OLD = `{% render 'product-variant-picker', product: product, block: block, product_form_id: product_form_id %}`;
const SWATCH = `${OLD}
                <style>
                  .lc-swatch-set legend{margin-bottom:.6rem}
                  .lc-swatch-set label.lc-swatch{position:relative;width:34px!important;height:34px!important;min-width:34px!important;padding:0!important;border-radius:50%!important;border:2px solid #d9d2c7!important;background:var(--sw)!important;box-shadow:inset 0 0 0 2px #fff;font-size:0!important;line-height:0!important;overflow:hidden;cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease}
                  .lc-swatch-set input:checked + label.lc-swatch{border-color:#D4A853!important;box-shadow:inset 0 0 0 2px #fff,0 0 0 2px #D4A853}
                  .lc-swatch-set input:focus-visible + label.lc-swatch{outline:2px solid #D4A853;outline-offset:2px}
                </style>
                <script>
                  (function(){
                    var C={'blanc':'#FFFFFF','white':'#FFFFFF','noir':'#1A1A1A','black':'#1A1A1A','gris':'#9aa0a6','grey':'#9aa0a6','gray':'#9aa0a6','gris foncé':'#4a4a4a','dark grey':'#4a4a4a','anthracite':'#36393d','charbon':'#36454f','charcoal':'#36454f','brun':'#7b5234','brown':'#7b5234','marron':'#6b4423','beige':'#d9c2a3','sable':'#dcc9a6','naturel':'#c8a97e','natural':'#c8a97e','bois':'#a9744f','wood':'#a9744f','chêne':'#c19a6b','oak':'#c19a6b','noyer':'#5c4433','walnut':'#5c4433','bleu':'#2f5fa6','blue':'#2f5fa6','marine':'#1b2a4a','navy':'#1b2a4a','turquoise':'#1aa3a3','vert':'#3b7a57','green':'#3b7a57','kaki':'#7a7d4a','rouge':'#b33a3a','red':'#b33a3a','bordeaux':'#6e1f2a','rose':'#e8a0b0','pink':'#e8a0b0','jaune':'#e8c24a','yellow':'#e8c24a','orange':'#e08a3c','crème':'#f2e9d8','cream':'#f2e9d8','ivoire':'#f5f0e1','ivory':'#f5f0e1','taupe':'#8b7e6a','argent':'#c0c0c0','silver':'#c0c0c0','or':'#d4af37','gold':'#d4af37','transparent':'#e9e9e9','multicolore':'linear-gradient(135deg,#b33a3a,#e8c24a,#3b7a57,#2f5fa6)','multicolor':'linear-gradient(135deg,#b33a3a,#e8c24a,#3b7a57,#2f5fa6)'};
                    function hex(t){var k=(t||'').trim().toLowerCase();if(C[k])return C[k];for(var key in C){if(k.indexOf(key)>=0)return C[key];}return null;}
                    function isColor(t){t=(t||'').trim().toLowerCase();return t==='couleur'||t==='color'||t==='colour'||t==='coloris';}
                    document.querySelectorAll('fieldset').forEach(function(fs){
                      var leg=fs.querySelector('legend');if(!leg||!isColor(leg.textContent))return;
                      var any=false;
                      fs.querySelectorAll('label').forEach(function(lab){
                        var h=hex(lab.textContent);if(!h)return;
                        lab.classList.add('lc-swatch');lab.style.setProperty('--sw',h);lab.setAttribute('title',(lab.textContent||'').trim());any=true;
                      });
                      if(any)fs.classList.add('lc-swatch-set');
                    });
                  })();
                </script>`;
if (mp.includes("lc-swatch-set")) console.log("swatches already present");
else { if (!mp.includes(OLD)) throw new Error("ABORT: variant_picker render not found"); mp = mp.replace(OLD, SWATCH); await putAsset("sections/main-product.liquid", mp, PREVIEW); console.log("main-product.liquid PUT 200 (color swatches added)"); }
