import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
let pass = true;
const rec = (ok, l, d) => { if (!ok) pass = false; console.log(`${ok ? "✅" : "❌"} ${l} — ${d}`); };

// --- Repositioning ---
const idx = JSON.parse(await getAsset("templates/index.json", P));
const o = idx.order;
const iVideo = o.indexOf("home_video");
const iPay = o.indexOf("shop_pay_home");
const iSale = o.indexOf("featured_sale");
const iColl = o.indexOf("featured_collection2");
rec(iVideo === iPay + 1, "home_video directly after shop_pay_home", `pay@${iPay}, video@${iVideo}`);
rec(iVideo < iSale && iVideo < iColl, "home_video before both carousels", `video@${iVideo} < featured_sale@${iSale}, featured_collection2@${iColl}`);
rec(idx.sections.home_video && idx.sections.home_video.type === "home-video-showcase", "section type intact", idx.sections.home_video && idx.sections.home_video.type);

// --- Section content ---
const s = await getAsset("sections/home-video-showcase.liquid", P);
const cardCount = (s.match(/class="hv-card"/g) || []).length;
const vids = (s.match(/<video /g) || []).length;
rec(cardCount === 6 && vids === 6, "6 cards / 6 videos in markup", `${cardCount} cards, ${vids} videos`);
rec(/@media\(min-width:750px\)\{\.hv-card:nth-child\(n\+5\)\{display:none\}\}/.test(s), "desktop hides cards 5-6 (4 shown)", "nth-child(n+5) display:none >=750px");
rec(/grid-template-columns:repeat\(4,1fr\)/.test(s), "desktop 4-up grid", "repeat(4,1fr)");
rec(/@media\(max-width:749px\)/.test(s) && /\.hv-ov\{opacity:1\}/.test(s), "mobile <750px shows all + overlay", "max-width:749 overrides");
rec(/mouseenter/.test(s) && /load\(v\); play\(v\)/.test(s), "desktop hover-to-play JS", "mouseenter -> load+play");
rec(/matchMedia\('\(min-width:750px\)'\)/.test(s), "desktop/mobile branch on 750px", "matchMedia gate");
rec(/IntersectionObserver/.test(s) && /data-src/.test(s), "mobile lazy autoplay retained", "IO + data-src");
rec(/\.hv-card:hover \.hv-ov/.test(s) && /:focus-within \.hv-ov\{opacity:1\}/.test(s), "hover overlay CSS present", "hv-card:hover/:focus-within hv-ov");
rec(/preload="none"/.test(s), "preload=none (no upfront fetch)", "video preload none");
rec(/Voyez-le chez vous/.test(s) && /See it at home/.test(s), "bilingual title intact", "FR/EN");
rec(/\{% schema %\}/.test(s), "section schema present", "valid section");

console.log(pass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(pass ? 0 : 1);
