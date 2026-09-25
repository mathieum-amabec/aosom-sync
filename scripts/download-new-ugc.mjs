// scripts/download-new-ugc.mjs — download the newly-discovered UGC clips into src/ugc/{SKU}.mp4.
// Network only: NO DB write (video_ugc is populated after the compliance scan, so a clip that
// gets deleted never leaves a dangling row).
//
//   node-x64 scripts/download-new-ugc.mjs
//
// Country priority CA > US > UK > DE, then FR as a LAST RESORT for SKUs available nowhere else.
// FR is normally never sourced (every FR clip is a Skeepers influencer review with the supplier
// name burned into the subtitles — 8/8 rejected in the 2026-07-08 scan); it is pulled here only
// so the requested FR/UK/DE compliance scan can re-validate that policy on real frames.
import { mkdirSync, createWriteStream, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SRC = "src/ugc";
const PRIORITY = ["CA", "US", "UK", "DE", "FR"];
mkdirSync(SRC, { recursive: true });

const probe = JSON.parse(readFileSync("docs/probe-ugc-countries.json", "utf8"));
const summary = JSON.parse(readFileSync("docs/probe-new-videos-summary.json", "utf8"));

// sku → { country → {url,len} }
const avail = {};
for (const h of summary.A) ((avail[h.sku] ||= {}).CA = { url: h.url, len: h.len });
for (const [c, hits] of Object.entries(probe.byCountry)) {
  for (const h of hits) ((avail[h.sku] ||= {})[c] = { url: h.url, len: h.len });
}

const skus = Object.keys(avail).sort();
console.log(`${skus.length} SKUs avec au moins un clip. Priorité ${PRIORITY.join(" > ")}.\n`);

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}

const manifest = [];
let ok = 0, skipped = 0, failed = 0;
for (const sku of skus) {
  const country = PRIORITY.find((c) => avail[sku][c]);
  const pick = avail[sku][country];
  const dest = `${SRC}/${sku}.mp4`;
  const others = PRIORITY.filter((c) => avail[sku][c]);
  if (existsSync(dest) && statSync(dest).size > 20000) {
    console.log(`▸ ${sku.padEnd(15)} [${country}] déjà présent, skip`);
    manifest.push({ sku, country, url: pick.url, bytes: statSync(dest).size, available: others, skipped: true });
    skipped++; continue;
  }
  try {
    await download(pick.url, dest);
    const bytes = statSync(dest).size;
    console.log(`▸ ${sku.padEnd(15)} [${country}] ${(bytes / 1048576).toFixed(2)} MB${others.length > 1 ? `  (aussi: ${others.filter((c) => c !== country).join(",")})` : ""}`);
    manifest.push({ sku, country, url: pick.url, bytes, available: others, skipped: false });
    ok++;
  } catch (e) {
    console.log(`✗ ${sku.padEnd(15)} [${country}] ÉCHEC — ${e.message}`);
    failed++;
  }
}

writeFileSync("docs/new-ugc-manifest.json", JSON.stringify(manifest, null, 2));
const byC = {};
for (const m of manifest) byC[m.country] = (byC[m.country] || 0) + 1;
console.log(`\nTéléchargés ${ok} · déjà présents ${skipped} · échecs ${failed}`);
console.log(`Par pays retenu : ${Object.entries(byC).map(([c, n]) => `${c}=${n}`).join(" · ")}`);
console.log(`Volume total : ${(manifest.reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(2)} MB`);
console.log(`→ docs/new-ugc-manifest.json`);
