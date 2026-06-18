// Build out/demand-gen/_previews/index.html — full contact sheet (1 frame per rendered asset).
// Expects preview PNGs already extracted to _previews/{basename}.png and out/demand-gen-manifest.json present.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const m = JSON.parse(readFileSync("out/demand-gen-manifest.json", "utf8"));
const sizeClass = { "16:9": "r169", "1:1": "r11", "9:16": "r916" };

const sections = m.videos
  .filter((v) => v.outputs && v.outputs.length)
  .map((v) => {
    const resBadge = v.height >= 1080 ? `<span class="ok">1080p</span>` : `<span class="flag">480p</span>`;
    const cards = v.outputs.map((o) => {
      const png = `${basename(o.file, ".mp4")}.png`;
      const has = existsSync(`out/demand-gen/_previews/${png}`);
      const cap = o.effective_sec < o.bucket_sec ? ` <span class="cap">(${o.effective_sec}s)</span>` : "";
      return `<figure class="${sizeClass[o.ratio]}">${has ? `<img src="${png}" loading="lazy">` : `<div class="missing">no frame</div>`}<figcaption>${o.ratio} · ${o.bucket_sec}s${cap}</figcaption></figure>`;
    }).join("");
    return `<h2>${v.sku} ${resBadge} <span class="t">${v.title_fr}</span></h2><div class="row">${cards}</div>`;
  }).join("\n");

const r = m.render || {};
const html = `<!doctype html><meta charset="utf-8">
<title>Demand Gen — planche complète (${r.ok ?? "?"} assets)</title>
<style>
 body{font-family:'DM Sans',system-ui,Arial,sans-serif;background:#0f1420;color:#eef;margin:0;padding:24px}
 h1{font-size:20px;color:#D4A853;margin:0 0 4px} h2{color:#cdd;margin:24px 0 8px;font-size:15px;font-weight:600}
 h2 .t{color:#9fb0c8;font-weight:400;font-size:13px} p.sub{color:#9fb0c8;font-size:13px;margin:0 0 6px}
 .row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
 figure{margin:0;background:#1B2A4A;border:1px solid #2c3f63;border-radius:8px;overflow:hidden}
 figure img,.missing{display:block;background:#000}
 .missing{display:flex;align-items:center;justify-content:center;color:#777;font-size:11px;height:120px;width:120px}
 .r169 img{width:300px} .r11 img{width:190px} .r916 img{width:120px}
 figcaption{padding:5px 8px;font-size:11px;color:#bcd}
 .flag{background:#5a2230;color:#ffb3b3;font-size:10px;padding:1px 6px;border-radius:6px}
 .ok{background:#1d4023;color:#b6f0c0;font-size:10px;padding:1px 6px;border-radius:6px}
 .cap{color:#D4A853}
</style>
<h1>Demand Gen — planche complète · ${r.ok ?? "?"} assets · ${r.total_mb ?? "?"} MB · rendu ${r.elapsed_sec ?? "?"}s</h1>
<p class="sub">Overlay FR (DM Sans, titre MAJUSCULES +25%, fond Navy 70%) + badge Gold « Livraison gratuite au Canada » sur scrim Navy 50%. Trim fenêtre propre par SKU; delogo sur 845-774V00BK. <span class="cap">(Ns)</span> = durée réelle si &lt; bucket.</p>
${sections}`;
writeFileSync("out/demand-gen/_previews/index.html", html);
console.log("Wrote out/demand-gen/_previews/index.html");
