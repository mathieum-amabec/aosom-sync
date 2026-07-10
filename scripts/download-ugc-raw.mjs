// scripts/download-ugc-raw.mjs — TASK 1: assemble all 61 RAW UGC clips (no
// processing) into Downloads/ugc-bruts/{sku}.mp4 for Mat.
//   • 14 new SKUs (UK/DE/FR) → downloaded fresh into src/ugc/ (country priority
//     CA > US > UK > FR > DE), then all of src/ugc (47 existing + 14) copied to ugc-bruts.
// Network only, no DB write. node-x64 (bun-x64 dies on network).
//
//   node-x64 scripts/download-ugc-raw.mjs
import { mkdirSync, createWriteStream, existsSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HOST = "https://uspm.aosomcdn.com";
// Country priority. FR is DELIBERATELY EXCLUDED: every /customer/FR/ clip is a
// Skeepers influencer review — third-party "Skeepers" watermark + burned-in FR
// subtitles that name the supplier ("...de chez Aosom", "envoyé par Aosom"),
// i.e. the strictly-forbidden supplier name gravé dans l'image. 8/8 FR clips
// were rejected in the 2026-07-08 scan, so we never source FR again. CA/US are
// clean unboxings; UK/DE are mixed → still spot-check before publishing.
const COUNTRIES = ["CA", "US", "UK", "DE"];               // priority order (FR excluded — see above)
const SRC_UGC = "src/ugc";
const BRUTS = "C:\\Users\\vente\\Downloads\\ugc-bruts";
const NEW_SKUS = [
  "311-048GY", "312-024RD", "34D-002V00RD", "370-027V00GY", "831-194WT",
  "835-290V00BG", "837-164WT", "839-281", "846-036", "846-112V00DG",
  "84D-031V01BU", "84D-270V00CG", "84G-391V00GG", "D30-204",
];

mkdirSync(SRC_UGC, { recursive: true });
mkdirSync(BRUTS, { recursive: true });

async function head(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && Number(r.headers.get("content-length") || 0) > 20000
      ? Number(r.headers.get("content-length")) : 0;
  } catch { return 0; }
}
async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}

console.log(`TASK 1 — downloading ${NEW_SKUS.length} new UGC clips into ${SRC_UGC}/\n`);
let dl = 0;
for (const sku of NEW_SKUS) {
  const dest = `${SRC_UGC}/${sku}.mp4`;
  if (existsSync(dest) && statSync(dest).size > 20000) { console.log(`▸ ${sku.padEnd(14)} déjà présent, skip`); dl++; continue; }
  let picked = null;
  for (const c of COUNTRIES) {
    const url = `${HOST}/aosomweb/customer/${c}/${sku}.mp4`;
    if (await head(url)) { picked = { c, url }; break; }
  }
  if (!picked) { console.log(`✗ ${sku.padEnd(14)} introuvable sur ${COUNTRIES.join("/")}`); continue; }
  await download(picked.url, dest);
  console.log(`▸ ${sku.padEnd(14)} [${picked.c}] → ${(statSync(dest).size / 1048576).toFixed(1)} MB`);
  dl++;
}

// Copy the full src/ugc set (47 + 14) into ugc-bruts for Mat.
console.log(`\nCopie de src/ugc → ${BRUTS} …`);
const clips = readdirSync(SRC_UGC).filter((f) => f.toLowerCase().endsWith(".mp4"));
let copied = 0;
for (const f of clips) {
  const s = `${SRC_UGC}/${f}`, d = `${BRUTS}\\${f}`;
  copyFileSync(s, d);
  copied++;
}
console.log(`\n=== DONE — ${dl}/${NEW_SKUS.length} nouveaux OK, ${copied} clips bruts dans ${BRUTS} ===`);
