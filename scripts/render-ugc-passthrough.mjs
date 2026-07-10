// scripts/render-ugc-passthrough.mjs — PASSTHROUGH treatment for Aosom UGC reels.
// Raw customer/UGC clip (src/ugc/{sku}.mp4), ORIGINAL audio kept, no big overlay text —
// only a small navy semi-transparent lower-third (Ameublo Direct logo on a white plate +
// gold "ameublodirect.ca"). The clip speaks for itself; promo copy lives in the FB/IG
// caption (printed below, NOT burned into the video). LOCAL only — no Blob, no queue.
//
//   FFMPEG_BIN="…/ffmpeg.exe" node-x64 scripts/render-ugc-passthrough.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, existsSync } from "node:fs";

const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const FONT = "fonts/DMSans.ttf";
const LOGO = "Logo/officiel-transparent.png";
const NAVY = "0x1A2340";
const GOLD = "0xD4A853";
const OUT_DIR = "C:\\Users\\vente\\Downloads\\test-ugc";
const CLIP_DIR = "src/ugc";
const W = 1080, H = 1920, BAR_H = 170, BAR_Y = H - BAR_H;

// 6 varied SKUs: 2 patio, 2 furniture, 1 kids, 1 pet. Titles for the caption.
const PICKS = [
  { sku: "860-015V00GG", cat: "patio",     title: "Ensemble de patio sectionnel rotin 6 pièces avec table" },
  { sku: "841-086V02GY", cat: "patio",     title: "Ensemble de meubles de patio rotin 4 pièces avec coussins" },
  { sku: "83B-401V00BG", cat: "meuble",    title: "Canapé 3 places moderne avec ressorts ensachés en lin" },
  { sku: "833-894V80WT", cat: "meuble",    title: "Table basse à plateau relevable avec rangement caché" },
  { sku: "342-018V80",   cat: "enfants",   title: "Château gonflable 6-en-1 avec trampoline, glissade et piscine" },
  { sku: "D31-078V01RB", cat: "animaux",   title: "Meuble cache-litière avec arbre à chat intégré" },
];

for (const p of [["Font", FONT], ["Logo", LOGO]]) if (!existsSync(p[1])) { console.error(`✗ ${p[0]} not found: ${p[1]}`); process.exit(1); }
mkdirSync(OUT_DIR, { recursive: true });

/** Generic FB/IG caption (NOT burned into the video). */
function caption(title) {
  return `🔥 GRANDE LIQUIDATION — ${title}\nÀ prix imbattable, livraison gratuite partout au Canada 🇨🇦\n👉 Magasinez sur ameublodirect.ca`;
}

// Lower-third: normalize to 1080x1920 (blurred-fill for any aspect) → navy bar →
// logo on a white plate (bottom-left) → gold URL (bottom-right). Original audio kept.
function filter() {
  const base =
    `[0:v]split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,setsar=1[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
  const bar = `[base]drawbox=x=0:y=${BAR_Y}:w=${W}:h=${BAR_H}:color=${NAVY}@0.65:t=fill[bar]`;
  const plateH = 88, plateW = 340, plateY = BAR_Y + Math.round((BAR_H - plateH) / 2);
  const logo =
    `[1:v]scale=300:-1[logo_s];` +
    `color=white@0.92:size=${plateW}x${plateH}:r=30[plate];` +
    `[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[logo_backed]`;
  const withLogo = `[bar][logo_backed]overlay=44:${plateY}[withlogo]`;
  const urlY = BAR_Y + Math.round((BAR_H - 46) / 2) - 4;
  const url = `[withlogo]drawtext=fontfile=${FONT}:text=ameublodirect.ca:fontcolor=${GOLD}:fontsize=46:borderw=1:bordercolor=black@0.4:x=W-text_w-56:y=${urlY}[vout]`;
  return `${base};${bar};${logo};${withLogo};${url}`;
}

const outputs = [];
for (const p of PICKS) {
  const src = `${CLIP_DIR}/${p.sku}.mp4`;
  if (!existsSync(src)) { console.error(`✗ ${p.sku}: clip missing (${src})`); continue; }
  const out = `${OUT_DIR}\\${p.sku}.mp4`;
  const args = [
    "-y", "-nostdin", "-loglevel", "error",
    "-i", src,                 // input 0: raw UGC clip (+ its original audio)
    "-loop", "1", "-i", LOGO,  // input 1: logo (held for the whole clip)
    "-filter_complex", filter(),
    "-map", "[vout]", "-map", "0:a?",   // keep original audio if present
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", out,
  ];
  process.stdout.write(`▸ ${p.sku.padEnd(14)} [${p.cat}] … `);
  try {
    execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    console.log(`ok (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
    outputs.push({ ...p, out });
  } catch (e) {
    console.log("FAIL");
    console.error(String(e.stderr || e.message).slice(0, 500));
  }
}

console.log(`\n=== DONE — ${outputs.length}/${PICKS.length} rendered → ${OUT_DIR} ===\n`);
for (const o of outputs) {
  console.log(`${o.out}   [${o.cat}]`);
  console.log(`   caption FB/IG (non brûlée) :`);
  console.log(caption(o.title).split("\n").map((l) => "     " + l).join("\n"));
  console.log("");
}
