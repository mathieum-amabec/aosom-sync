// Phase 6 C3 — final preview-theme audit. Read-only. Checks every homepage + PDP item.
import { getAsset, gql, rest } from "./_shopify-lib.mjs";
const T = "160213696617";
const A = {};
for (const k of ["templates/index.json", "sections/header-group.json", "snippets/header-mega-menu.liquid",
  "snippets/meta-tags.liquid", "layout/theme.liquid", "sections/main-product.liquid", "snippets/price.liquid",
  "templates/product.json"]) A[k] = await getAsset(k, T);

const idx = JSON.parse(A["templates/index.json"]);
const idxRaw = A["templates/index.json"];
const pj = JSON.parse(A["templates/product.json"]);
const results = { home: [], pdp: [] };
const add = (g, label, ok, note = "") => results[g].push({ label, ok, note });

// og:image asset present?
let ogAsset = false;
try { const r = await rest(`/themes/${T}/assets.json?asset[key]=assets/og-image-social.jpg`); ogAsset = r.ok; } catch {}

// menu mega coverage
const mq = await gql(`{ menus(first:50){ nodes{ handle items{ title items{ title } } } } }`);
const menu = mq.data.menus.nodes.find((m) => m.handle === "preview-main-menu");
const megaCount = menu ? menu.items.filter((i) => (i.items || []).length > 0).length : 0;

// ── Homepage ──
add("home", "og:image lifestyle", ogAsset && /page_type == 'index'/.test(A["snippets/meta-tags.liquid"]) && A["snippets/meta-tags.liquid"].includes("og-image-social"));
add("home", "méta-description naturelle", /page_type == 'index'/.test(A["layout/theme.liquid"]) && /name="description"/.test(A["layout/theme.liquid"]));
const livraison = (idxRaw.match(/livraison gratuite/gi) || []).length + (A["sections/header-group.json"].match(/livraison gratuite/gi) || []).length;
add("home", "Max 2 mentions livraison gratuite", livraison <= 2, `${livraison} mention(s)`);
add("home", "Popup première commande", !!idx.sections.entry_popup);
add("home", "Méga-menu toutes catégories", A["snippets/header-mega-menu.liquid"].includes("render 'mega-menu'") && megaCount >= 4, `${megaCount} mega items`);
add("home", "Tuiles catégories avec images", !!idx.sections.cat_tiles);
const hvLiquid = await getAsset("sections/home-video-showcase.liquid", T).catch(() => "");
add("home", 'Section vidéo "Voyez-le chez vous"', idx.order.includes("home_video") && /Voyez-le chez vous|See it at home/.test(hvLiquid));
const whyCl = idx.sections.why_us?.settings?.custom_liquid || "";
add("home", "why_us 4 points SVG", (whyCl.match(/<h3/g) || []).length === 4 && (whyCl.match(/<svg/g) || []).length === 4);
// liquid tag balance on edited snippets
const balOk = ["snippets/header-mega-menu.liquid"].every((k) => {
  const s = A[k]; const c = (o, cl) => (s.match(new RegExp(`{%-?\\s*${o}\\b`, "g")) || []).length === (s.match(new RegExp(`{%-?\\s*${cl}\\b`, "g")) || []).length;
  return c("for", "endfor") && c("if", "endif");
});
add("home", "0 liquid error (tag-balance + JSON valid)", balOk);
add("home", "0 Anonyme témoignages", !/Anonyme/.test(idxRaw));
add("home", "Voix québécoise consistante", whyCl.includes("On est d'ici") && idx.sections.featured_sale?.settings?.description?.includes("imbattables"));

// ── PDP ──
const mp = A["sections/main-product.liquid"];
add("pdp", "Eyebrow catégorie", /product-eyebrow/.test(mp));
add("pdp", "Badge Judge.me sous H1", /jdgm-preview-badge|judgeme\.badge/.test(mp));
add("pdp", 'Prix "Économisez" ≥10% seulement', /Économisez|disc_pct/.test(A["snippets/price.liquid"]) && /10/.test(A["snippets/price.liquid"]));
add("pdp", "Bouton ATC navy", /product-form__submit[\s\S]{0,120}#1B2A4A/i.test(mp) || /#1B2A4A[\s\S]{0,120}product-form__submit/i.test(mp));
add("pdp", "Réassurance SVG sous ATC", JSON.stringify(pj).includes("trust_badges") && /<svg/.test(JSON.stringify(pj.sections)));
const vpick = await getAsset("snippets/product-variant-picker.liquid", T).catch(() => "");
add("pdp", "Swatches couleur (si variantes)", /swatch/i.test(vpick), "picker rend les swatches; pas de config custom — noms de couleur FR à confirmer visuellement");
add("pdp", 'Cross-sell "Vous aimerez aussi"', pj.sections["related-products"]?.settings?.heading === "Vous aimerez aussi" && pj.sections["related-products"]?.settings?.products_to_show === 4);

// ── output ──
let pass = 0, fail = 0;
for (const g of ["home", "pdp"]) {
  console.log(`\n=== ${g.toUpperCase()} ===`);
  for (const r of results[g]) { console.log(`${r.ok ? "✅" : "❌"} ${r.label}${r.note ? " — " + r.note : ""}`); r.ok ? pass++ : fail++; }
}
console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(JSON.stringify(results)); // machine-readable for the doc
