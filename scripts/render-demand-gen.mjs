// Demand Gen video renderer — FULL BATCH (13 viable sources × ratios × durations).
// Transforms existing real product MP4s into Demand Gen assets. No AI generation.
//   16:9 → scale+pad (native ratio)   |   1:1 / 9:16 → blurred-fill padded canvas
//   Per source: trim to the clean window (ss + cleanDur), delogo only where a logo is persistent.
//   Overlay (drawtext): FR title (white, DM Sans) + benefit line (Gold) over a Navy 35% bottom scrim,
//   bottom-centered, 10% safe zone.
// Run from the worktree root:  node scripts/render-demand-gen.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";

const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const FONT = "fonts/DMSans.ttf";
const GOLD = "0xD4A853";
const BENEFIT = "Livraison gratuite au Canada";
const SCRIM_OPACITY = 0.35;   // Navy bottom gradient peak alpha
const SCRIM_FRACTION = 0.18;  // band height = 18% of canvas

// 13 viable sources (audit). ss/cleanDur = clean-window trim (s). buckets = duration cuts to emit.
const SOURCES = [
  { sku:"01-0415",      title:"Base de parasol carrée résine 9 kg — bronze", ss:4.0, cleanDur:13.5, delogo:null, buckets:[6,15] },
  { sku:"845-774V00BK", title:"Jardinière surélevée acier galvanisé avec tiges renforcées 180cm", ss:0.5, cleanDur:17.5, delogo:"delogo=x=6:y=6:w=260:h=120", buckets:[6,15] },
  { sku:"01-0893",      title:"Balançoire de jardin double à bascule pour patio", ss:2.0, cleanDur:14.0, delogo:null, buckets:[6,15] },
  { sku:"845-039V01GY", title:"Jardinière surélevée galvanisée acier 120x60x30cm", ss:3.0, cleanDur:27.0, delogo:null, buckets:[6,15,30] },
  { sku:"845-335",      title:"Agenouilloir de jardin pliable avec coussin mousse EVA", ss:1.0, cleanDur:34.0, delogo:null, buckets:[6,15,30] },
  { sku:"845-518GY",    title:"Bac de jardinage surélevé galvanisé 241 x 91 x 30 cm", ss:13.0, cleanDur:11.0, delogo:null, buckets:[6,15] },
  { sku:"845-792V00YL", title:"Jardinière surélevée avec treillis pour plantes grimpantes — jaune", ss:6.0, cleanDur:11.0, delogo:null, buckets:[6,15] },
  { sku:"84A-054V05BK", title:"Balancelle de patio 3 places avec auvent ajustable", ss:7.0, cleanDur:28.0, delogo:null, buckets:[6,15,30] },
  { sku:"84B-136",      title:"Coussins de remplacement pour banc 3 places extérieur", ss:4.0, cleanDur:12.0, delogo:null, buckets:[6,15] },
  { sku:"84B-146BU",    title:"Chaise longue pliante 5 positions avec trou visage", ss:3.0, cleanDur:15.0, delogo:null, buckets:[6,15] },
  { sku:"84C-226CG",    title:"Rideaux gazebo universels 4 panneaux 10' x 12' — Foncé", ss:0.5, cleanDur:11.5, delogo:null, buckets:[6,15] },
  { sku:"84H-209V00CG", title:"Bac surélevé galvanisé 152 x 91 x 61 cm", ss:7.0, cleanDur:16.0, delogo:null, buckets:[6,15] },
  { sku:"D51-277V01",   title:"Enclos pour poules extérieur avec toit 3,0 x 4,0 x 2,0 m", ss:0.5, cleanDur:22.5, delogo:null, buckets:[6,15] },
];

const RATIOS = {
  "16:9": { W:1920, H:1080, titleFs:54, benFs:46, wrap:42 },
  "1:1":  { W:1080, H:1080, titleFs:46, benFs:40, wrap:24 },
  "9:16": { W:1080, H:1920, titleFs:48, benFs:42, wrap:24 },
};

function wrap(text, max) {
  const words = text.split(/\s+/);
  const lines = []; let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function overlayChain(cfg, titleLines, lineDir) {
  const { H, titleFs, benFs } = cfg;
  const bottomMargin = Math.round(0.10 * H);
  const spacing = Math.round(titleFs * 1.34);
  const benTop = H - bottomMargin - Math.round(benFs * 1.15);
  const shadow = "shadowcolor=black@0.55:shadowx=3:shadowy=3";
  const parts = []; const t = titleLines.length;
  titleLines.forEach((line, i) => {
    const file = `${lineDir}/t${i}.txt`;
    writeFileSync(file, line, "utf8");
    const y = benTop - spacing * (t - i);
    parts.push(`drawtext=fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${titleFs}:x=(w-text_w)/2:y=${y}:${shadow}`);
  });
  const benFile = `${lineDir}/ben.txt`;
  writeFileSync(benFile, BENEFIT, "utf8");
  parts.push(`drawtext=fontfile=${FONT}:textfile=${benFile}:fontcolor=${GOLD}:fontsize=${benFs}:x=(w-text_w)/2:y=${benTop}:${shadow}`);
  return parts.join(",");
}

function buildFilter(ratio, cfg, drawChain, delogo) {
  const { W, H } = cfg;
  const pre = delogo ? `${delogo},` : "";
  let base;
  if (ratio === "16:9") {
    base = `[0:v]${pre}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[base]`;
  } else {
    base = `[0:v]${pre}split=2[a][b];` +
           `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,setsar=1[bg];` +
           `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
           `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
  }
  const Hs = Math.round(SCRIM_FRACTION * H);
  const scrim = `color=c=0x1B2A4A:s=${W}x${Hs}:r=30,format=rgba,` +
                `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${SCRIM_OPACITY}*255*(Y/(H-1))'[scrim]`;
  return `${base};${scrim};[base][scrim]overlay=0:${H - Hs}:shortest=1[scr];[scr]${drawChain}[vout]`;
}

const t0 = Date.now();
const report = [];
let ok = 0, fail = 0, bytes = 0;
for (const s of SOURCES) {
  const src = `src/${s.sku}.mp4`;
  const outDir = `out/demand-gen/${s.sku}`;
  mkdirSync(outDir, { recursive: true });
  for (const [ratio, cfg] of Object.entries(RATIOS)) {
    const titleLines = wrap(s.title, cfg.wrap);
    for (const bucket of s.buckets) {
      const effDur = Math.min(bucket, s.cleanDur);
      const rtag = ratio.replace(":", "x");
      const lineDir = `tmp_lines/${s.sku}_${rtag}_${bucket}`;
      mkdirSync(lineDir, { recursive: true });
      const filter = buildFilter(ratio, cfg, overlayChain(cfg, titleLines, lineDir), s.delogo);
      const out = `${outDir}/${s.sku}_${rtag}_${bucket}s.mp4`;
      const args = [
        "-y", "-nostdin", "-loglevel", "error",
        "-ss", String(s.ss), "-i", src, "-t", String(effDur),
        "-filter_complex", filter, "-map", "[vout]", "-map", "0:a?",
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ];
      process.stdout.write(`${out} (${effDur}s) … `);
      try {
        execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
        const sz = statSync(out).size; bytes += sz; ok++;
        report.push({ sku: s.sku, ratio, bucket, effective_sec: Number(effDur.toFixed(1)), file: out, size: sz, ok: true });
        console.log("ok");
      } catch (e) {
        fail++;
        report.push({ sku: s.sku, ratio, bucket, effective_sec: Number(effDur.toFixed(1)), file: out, ok: false, error: String(e.stderr || e.message).slice(0, 300) });
        console.log("FAIL");
      }
      rmSync(lineDir, { recursive: true, force: true });
    }
  }
}
rmSync("tmp_lines", { recursive: true, force: true });
const elapsed = (Date.now() - t0) / 1000;
writeFileSync("out/render-report.json", JSON.stringify({ ok, fail, total_bytes: bytes, elapsed_sec: Number(elapsed.toFixed(1)), assets: report }, null, 2));
console.log(`\n=== BATCH DONE === ok=${ok} fail=${fail} · ${(bytes/1048576).toFixed(1)} MB · ${elapsed.toFixed(1)}s`);
if (fail) report.filter(r => !r.ok).forEach(r => console.log(`  FAIL ${r.file}: ${r.error}`));
