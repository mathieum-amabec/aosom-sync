// feature/video-section-horizontal-scroll — mobile (<750px) horizontal swipe carousel.
// Desktop (>=750px) untouched. PREVIEW theme only (160213696617); live guarded.
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT: preview === live");

const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t) throw new Error("ABORT: preview theme not found");
if (t.role !== "unpublished") throw new Error(`ABORT: target role is '${t.role}', expected 'unpublished'`);
console.log(`Target: ${t.id} "${t.name}" [${t.role}]`);

const section = await getAsset("sections/home-video-showcase.liquid", PREVIEW);

// Exact current mobile block (vertical grid). Replace ONLY this — desktop stays byte-identical.
const OLD = `  /* Mobile (<750px): all 6 cards, autoplay muted loop, overlay always visible */
  @media(max-width:749px){.hv-grid{grid-template-columns:repeat(2,1fr)}.hv-ov{opacity:1}}
  @media(max-width:480px){.hv-grid{grid-template-columns:1fr}}`;

const NEW = `  /* Mobile (<750px): horizontal swipe carousel — snap per card, no scrollbar, all 6 cards */
  @media(max-width:749px){
    .hv-grid{display:flex;flex-direction:row;overflow-x:scroll;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;gap:12px;padding:0 16px 16px}
    .hv-grid::-webkit-scrollbar{display:none}
    .hv-card{scroll-snap-align:start;flex:0 0 80vw;max-width:320px}
    .hv-ov{opacity:1}
  }`;

if (!section.includes(OLD)) {
  if (section.includes("overflow-x:scroll") && section.includes("scroll-snap-type:x mandatory")) {
    console.log("Already applied (carousel CSS present) — idempotent no-op.");
    process.exit(0);
  }
  throw new Error("ABORT: expected mobile CSS block not found — asset drifted, not modifying blindly.");
}
const count = section.split(OLD).length - 1;
if (count !== 1) throw new Error(`ABORT: expected exactly 1 match, found ${count}`);

const updated = section.replace(OLD, NEW);
// Sanity: desktop grid must remain intact.
if (!updated.includes(".hv-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}"))
  throw new Error("ABORT: desktop 4-col grid missing after edit");
if (!updated.includes("@media(min-width:750px){.hv-card:nth-child(n+5){display:none}}"))
  throw new Error("ABORT: desktop hide-rule missing after edit");

await putAsset("sections/home-video-showcase.liquid", updated, PREVIEW);
console.log("PUT sections/home-video-showcase.liquid -> 200");
