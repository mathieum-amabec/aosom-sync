// Read-only audit of preview theme 160213696617 for the pre-publish checklist.
// Pure Shopify Admin API reads — touches no git state.
import { rest, getAsset, gql } from "./_shopify-lib.mjs";
const P = "160213696617";

const out = {};
// 0. confirm theme
const themes = (await (await rest("/themes.json")).json()).themes;
const t = themes.find((x) => String(x.id) === P);
out.theme = t ? `${t.id} "${t.name}" [${t.role}]` : "NOT FOUND";

// 1. asset inventory (names only)
const assets = (await (await rest(`/themes/${P}/assets.json`)).json()).assets.map((a) => a.key);
out.assetCount = assets.length;
const has = (k) => assets.includes(k);
out.keyAssets = {
  "sections/home-video-showcase.liquid": has("sections/home-video-showcase.liquid"),
  "sections/page-voyez-le.liquid": has("sections/page-voyez-le.liquid"),
  "templates/page.voyez-le.json": has("templates/page.voyez-le.json"),
  "snippets/mega-menu.liquid": has("snippets/mega-menu.liquid"),
  "layout/theme.liquid": has("layout/theme.liquid"),
};
// find product + swatch related assets
out.productAssets = assets.filter((k) => /product|swatch|cross|menu/i.test(k));

// 2. helper to fetch safely
const grab = async (k) => (has(k) ? await getAsset(k, P) : null);
const idxRaw = await grab("templates/index.json");
const idx = idxRaw ? JSON.parse(idxRaw) : null;
const home = await grab("sections/home-video-showcase.liquid");
const voyez = await grab("sections/page-voyez-le.liquid");
const voyezTpl = await grab("templates/page.voyez-le.json");
const mega = await grab("snippets/mega-menu.liquid");
const theme = await grab("layout/theme.liquid");

// ---- HOMEPAGE checks ----
const order = idx ? idx.order : [];
const typeOf = (id) => (idx && idx.sections[id] ? idx.sections[id].type : null);
const iVideo = order.indexOf("home_video");
const carouselIdx = order
  .map((id, i) => (typeOf(id) === "featured-collection" ? i : -1))
  .filter((i) => i >= 0);
out.HOME = {
  order: order.join(", "),
  videoBeforeCarousels: iVideo >= 0 && carouselIdx.length > 0 && iVideo < Math.min(...carouselIdx),
  videoIdx: iVideo,
  firstCarouselIdx: carouselIdx.length ? Math.min(...carouselIdx) : null,
  desktopHoverGate: home ? /\(hover:hover\) and \(pointer:fine\)/.test(home) : null,
  desktopPosterStatic: home ? /preload="none"/.test(home) && /poster=/.test(home) : null,
  mobileAutoplay: home ? /IntersectionObserver/.test(home) && /muted/.test(home) && /loop/.test(home) : null,
  whyUsPresent: order.includes("why_us"),
  popupPresent: order.some((id) => /popup/i.test(id)),
  catTilesPresent: order.includes("cat_tiles"),
};
// why_us SVG icons + navy
const whyUs = idx && idx.sections.why_us ? JSON.stringify(idx.sections.why_us) : (theme || "");
// cat_tiles content (custom-liquid stored inline in index.json)
const catTiles = idx && idx.sections.cat_tiles ? JSON.stringify(idx.sections.cat_tiles) : "";
out.HOME.catTilesUnsplash = /unsplash/i.test(catTiles);
out.HOME.whyUsSvgNavy = /<svg/i.test(whyUs + catTiles + (theme || "")) ;
// livraison gratuite mentions across all index.json custom-liquid sections
const idxBlob = idxRaw || "";
out.HOME.livraisonGratuiteCount = (idxBlob.match(/livraison gratuite/gi) || []).length;
// mega-menu categories
out.HOME.megaMenu = mega
  ? {
      mobilierExt: /mobilier|patio|ext[ée]rieur|jardin/i.test(mega),
      meubles: /meuble/i.test(mega),
      animaux: /animau|pawhut|animal/i.test(mega),
      enfants: /enfant/i.test(mega),
    }
  : "NO mega-menu.liquid";

// ---- VOYEZ-LE PAGE checks ----
const pagesRes = await rest("/pages.json?limit=250");
const pages = (await pagesRes.json()).pages || [];
const vpage = pages.find((p) => p.handle === "voyez-le-chez-vous");
out.VOYEZ = {
  pageExists: !!vpage,
  pageHandle: vpage ? vpage.handle : null,
  pageTemplateSuffix: vpage ? vpage.template_suffix : null,
  pagePublished: vpage ? !!vpage.published_at : null,
  templateJsonPresent: !!voyezTpl,
  sectionPresent: !!voyez,
  cardCount: voyez ? (voyez.match(/all_products\[/g) || []).length : 0,
  categoryFilter: voyez ? /filtre|filter|data-cat|categor/i.test(voyez) : null,
};
// menu link
const menuQ = `{ menus(first:20){ nodes{ handle title items{ title url items{ title url } } } } }`;
let menuLink = null;
try {
  const m = await gql(menuQ);
  const blob = JSON.stringify(m);
  menuLink = /voyez-le-chez-vous|Voyez-le chez vous/i.test(blob);
} catch (e) {
  menuLink = "menu query failed: " + e.message;
}
out.VOYEZ.menuLink = menuLink;

// ---- PDP checks ----
const prodSectionKey = out.productAssets.find((k) => /main-product|product-template|product\.liquid|sections\/product/i.test(k));
out.PDP = { sectionFile: prodSectionKey || "NOT IDENTIFIED" };
if (prodSectionKey) {
  const pdp = await grab(prodSectionKey);
  out.PDP.eyebrow = /eyebrow|sur-?titre|category|categorie/i.test(pdp);
  out.PDP.judgemeBadge = /judge\.?me|jdgm/i.test(pdp);
  out.PDP.atcNavy = /1B2A4A|navy/i.test(pdp);
  out.PDP.crossSell = /aimerez aussi|cross-?sell|vous aimerez/i.test(pdp);
}
// swatches snippet
const swatchKey = out.productAssets.find((k) => /swatch/i.test(k));
out.PDP.swatchFile = swatchKey || "NOT IDENTIFIED";
if (swatchKey) {
  const sw = await grab(swatchKey);
  out.PDP.swatchEntries = (sw.match(/=>/g) || sw.match(/:/g) || []).length;
  out.PDP.swatchBilingual = /title_en|_en|english/i.test(sw);
}

console.log(JSON.stringify(out, null, 2));
