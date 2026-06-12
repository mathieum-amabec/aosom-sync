import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
let pass = true;
const rec = (ok, l, d) => { if (!ok) pass = false; console.log(`${ok ? "✅" : "❌"} ${l} — ${d}`); };
const s = await getAsset("sections/home-video-showcase.liquid", P);

// Mobile carousel — isolate the max-width:749 block.
const m = s.match(/@media\(max-width:749px\)\{[\s\S]*?\n  \}/);
const mob = m ? m[0] : "";
rec(!!mob, "mobile @media(max-width:749px) block present", mob ? `${mob.length} chars` : "NOT FOUND");
rec(/display:flex/.test(mob) && /flex-direction:row/.test(mob), "display:flex row", "flex container");
rec(/overflow-x:scroll/.test(mob) && /overflow-y:hidden/.test(mob), "overflow-x:scroll / y:hidden", "horizontal scroll");
rec(/scroll-snap-type:x mandatory/.test(mob), "scroll-snap-type x mandatory", "snap axis");
rec(/scroll-snap-align:start/.test(mob), "scroll-snap-align:start on card", "snap per card");
rec(/flex:0 0 80vw/.test(mob) && /max-width:320px/.test(mob), "card flex 0 0 80vw / max 320px", "80% width + edge of next");
rec(/-webkit-overflow-scrolling:touch/.test(mob), "-webkit-overflow-scrolling:touch", "momentum scroll iOS");
rec(/scrollbar-width:none/.test(mob) && /::-webkit-scrollbar\{display:none\}/.test(mob), "scrollbar hidden (FF + webkit)", "no visible scrollbar");
rec(/\.hv-ov\{opacity:1\}/.test(mob), "mobile overlay always visible", "hv-ov opacity 1");

// Desktop unchanged.
rec(/\.hv-grid\{display:grid;grid-template-columns:repeat\(4,1fr\);gap:18px\}/.test(s), "desktop 4-col grid intact", "repeat(4,1fr)");
rec(/@media\(min-width:750px\)\{\.hv-card:nth-child\(n\+5\)\{display:none\}\}/.test(s), "desktop hides cards 5-6 intact", "nth-child(n+5) >=750px");
rec(/grid-template-columns:repeat\(2/.test(s) === false && /grid-template-columns:1fr/.test(s) === false, "old vertical mobile grid removed", "no repeat(2)/1fr leftovers");

// Cards + JS intact.
rec((s.match(/class="hv-card"/g) || []).length === 6, "6 cards present", `${(s.match(/class="hv-card"/g) || []).length}`);
rec(/IntersectionObserver/.test(s) && /\(hover:hover\) and \(pointer:fine\)/.test(s), "JS branch logic intact", "IO + hover-gate untouched");

console.log(pass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(pass ? 0 : 1);
