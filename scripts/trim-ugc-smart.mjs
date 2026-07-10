// scripts/trim-ugc-smart.mjs — smart-cap the branded UGC test clips to 20s max.
// For each clip in test-ugc/, measures per-frame motion energy (temporal frame
// difference → average luma), slides a 20s window, and keeps the most dynamic
// 20s. Clips already ≤20s are copied whole. Output → test-ugc-trimmed/.
//
//   FFMPEG_BIN="…/ffmpeg.exe" node-x64 scripts/trim-ugc-smart.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, copyFileSync, statSync, readFileSync, rmSync } from "node:fs";

const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
const IN_DIR = "C:\\Users\\vente\\Downloads\\test-ugc";
const OUT_DIR = "C:\\Users\\vente\\Downloads\\test-ugc-trimmed";
const CAP = 20;                 // seconds
// Relative filename only — an absolute Windows path (C:\…) breaks the ffmpeg
// filtergraph parser (the drive-letter colon reads as an option separator).
const TMP = "ugc-motion.txt";

mkdirSync(OUT_DIR, { recursive: true });

function duration(f) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" });
  return parseFloat(out.trim());
}

// Per-second motion energy: fps=5 sampling, downscaled, temporal difference,
// average luma of the diff frame (higher = more movement between frames).
function motionBySecond(f, dur) {
  try { rmSync(TMP, { force: true }); } catch {}
  execFileSync(FFMPEG, [
    "-nostdin", "-loglevel", "error", "-i", f, "-an",
    "-vf", `fps=5,scale=160:-1,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${TMP}`,
    "-f", "null", "-",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const txt = readFileSync(TMP, "utf8");
  const bins = new Array(Math.ceil(dur)).fill(0);
  const counts = new Array(Math.ceil(dur)).fill(0);
  let t = 0;
  for (const line of txt.split(/\r?\n/)) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) { t = parseFloat(mt[1]); continue; }
    const my = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (my) { const s = Math.min(bins.length - 1, Math.floor(t)); bins[s] += parseFloat(my[1]); counts[s]++; }
  }
  return bins.map((v, i) => (counts[i] ? v / counts[i] : 0));  // mean energy per second
}

// Best CAP-second window start (integer second) maximizing summed motion.
function bestStart(energy, dur) {
  const maxStart = Math.max(0, Math.floor(dur - CAP));
  if (maxStart === 0) return 0;
  let best = 0, bestSum = -1;
  for (let s = 0; s <= maxStart; s++) {
    let sum = 0;
    for (let k = s; k < Math.min(energy.length, s + CAP); k++) sum += energy[k];
    if (sum > bestSum) { bestSum = sum; best = s; }
  }
  return best;
}

const files = readdirSync(IN_DIR).filter((f) => f.toLowerCase().endsWith(".mp4"));
console.log(`Trimming ${files.length} clips → ${OUT_DIR} (cap ${CAP}s)\n`);
for (const f of files) {
  const src = `${IN_DIR}\\${f}`, out = `${OUT_DIR}\\${f}`;
  const dur = duration(src);
  if (dur <= CAP + 0.2) {
    copyFileSync(src, out);
    console.log(`▸ ${f.padEnd(20)} ${dur.toFixed(1)}s ≤ ${CAP}s → copié tel quel`);
    continue;
  }
  const energy = motionBySecond(src, dur);
  const start = bestStart(energy, dur);
  execFileSync(FFMPEG, [
    "-y", "-nostdin", "-loglevel", "error",
    "-ss", String(start), "-i", src, "-t", String(CAP),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const mb = (statSync(out).size / 1048576).toFixed(1);
  console.log(`▸ ${f.padEnd(20)} ${dur.toFixed(1)}s → garde [${start}s–${start + CAP}s]  (fenêtre la + dynamique, ${mb} MB)`);
}
console.log(`\n=== DONE → ${OUT_DIR} ===`);
