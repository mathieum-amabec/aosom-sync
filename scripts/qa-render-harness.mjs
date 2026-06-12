// QA harness: pull the DEPLOYED section asset, extract its real <style>/<script>
// verbatim, wrap faithful 6-card markup, and emit two standalone HTML files that
// force each JS branch deterministically (matchMedia stubbed) so headless Chromium
// can exercise desktop hover-to-play and mobile/tablet autoplay without a live theme.
import { getAsset } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const section = await getAsset("sections/home-video-showcase.liquid", "160213696617");
const style = (section.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
const script = (section.match(/<script>[\s\S]*?<\/script>/) || [""])[0];
if (!style || !script) throw new Error("could not extract style/script from asset");

// Faithful poster: data-URI SVG so desktop shows a static image (proves no video fetch).
const poster = (n) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='480'><rect width='100%' height='100%' fill='#cdd3df'/><text x='50%' y='50%' font-family='sans-serif' font-size='40' fill='#1B2A4A' text-anchor='middle' dominant-baseline='middle'>Poster ${n}</text></svg>`
  );
const vid = "https://uspm.aosomcdn.com/videos/en/8/84C-546V00CG/84C-546V00CG-Outsunny-WEB.mp4";

// Card markup mirrors the Liquid output exactly (.hv-card > .hv-vid > source[data-src] + .hv-ov).
const cards = Array.from({ length: 6 }, (_, i) => i + 1)
  .map(
    (n) => `      <a class="hv-card" href="#" data-umami-event="Home video Produit ${n}">
        <video class="hv-vid" muted loop playsinline preload="none" poster="${poster(n)}"><source data-src="${vid}" type="video/mp4"></video>
        <span class="hv-ov"><span class="hv-t">Produit Aosom ${n}</span><span class="hv-p">199,99 $</span></span>
      </a>`
  )
  .join("\n");

const body = `<div class="hv-wrap" style="background:#FAFAF8">
  <div class="page-width hv-inner">
    <h2 class="hv-h">Voyez-le chez vous</h2>
    <p class="hv-sub">Découvrez nos produits dans de vrais espaces de vie</p>
    <div class="hv-grid">
${cards}
    </div>
  </div>
</div>
${style}`;

// matchMedia stub controls ONLY the JS branch (canHover). CSS @media still keys off the
// real viewport, so card layout (4 vs 6) is tested honestly at each width.
const harness = (forceHover) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{margin:0;font-family:sans-serif}.page-width{max-width:1200px;margin:0 auto;padding:0 16px}</style>
<script>
  // Force JS playback branch deterministically (headless hover detection is unreliable).
  window.__forceHover = ${forceHover};
  window.matchMedia = function(q){
    var wantsHover = /hover:\\s*hover/.test(q) && /pointer:\\s*fine/.test(q);
    return { matches: window.__forceHover ? wantsHover : false, media:q,
      addEventListener:function(){}, removeEventListener:function(){}, addListener:function(){}, removeListener:function(){} };
  };
</script>
</head><body>
${body}
${script}
</body></html>`;

const dir = join(tmpdir(), "hv-qa");
mkdirSync(dir, { recursive: true });
const desktop = join(dir, "harness-desktop.html");
const mobile = join(dir, "harness-mobile.html");
writeFileSync(desktop, harness(true), "utf8");
writeFileSync(mobile, harness(false), "utf8");
console.log("DESKTOP_HARNESS:", desktop);
console.log("MOBILE_HARNESS:", mobile);
console.log("style_len:", style.length, "script_len:", script.length);
