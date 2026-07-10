// scripts/render-ugc-branded-batch.mjs — TASK 2: brand every UGC clip (full, no
// trim) with a slideshow music bed + the navy lower-third (Ameublo Direct logo +
// gold ameublodirect.ca). LOCAL only — no Blob, no queue, no DB.
//
//   • clip: full length, blurred-fill → 1080x1920, original audio kept
//   • music: pickMusicTrack()-style pick from src/audio (rotated per clip),
//            volume -12dB, afade in 0.3s / out 1s, mixed UNDER the clip audio
//   • lower-third: navy@0.65 bar + logo on white plate (bottom-left) + gold URL
//
// Idempotent: skips clips whose output already exists (resume across windows).
// Concurrency 2. Run repeatedly until "remaining: 0".
//
//   FFMPEG_BIN="…/ffmpeg.exe" node-x64 scripts/render-ugc-branded-batch.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, existsSync, statSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
const FONT = "fonts/DMSans.ttf";
const LOGO = "Logo/officiel-transparent.png";
const NAVY = "0x1A2340", GOLD = "0xD4A853";
const IN_DIR = "src/ugc";
const OUT_DIR = "C:\\Users\\vente\\Downloads\\ugc-with-branding";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const W = 1080, H = 1920, BAR_H = 170, BAR_Y = H - BAR_H;

for (const [n, p] of [["Font", FONT], ["Logo", LOGO]]) if (!existsSync(p)) { console.error(`✗ ${n}: ${p}`); process.exit(1); }
mkdirSync(OUT_DIR, { recursive: true });

// pickMusicTrack() equivalent: all bundled tracks (src/audio + public/music).
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg)$/i;
function listTracks(dir) { try { return readdirSync(dir).filter((f) => AUDIO_EXT.test(f)).map((f) => path.resolve(dir, f)); } catch { return []; } }
const TRACKS = [...listTracks("src/audio"), ...listTracks("public/music")];
if (TRACKS.length === 0) { console.error("✗ aucune piste musicale dans src/audio ou public/music"); process.exit(1); }
console.log(`Pistes musicales (${TRACKS.length}) : ${TRACKS.map((t) => path.basename(t)).join(", ")}\n`);

function probe(f) {
  const dur = parseFloat(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim());
  const a = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim();
  return { dur, hasAudio: a.includes("audio") };
}

function videoFilter() {
  const plateH = 88, plateW = 340, plateY = BAR_Y + Math.round((BAR_H - plateH) / 2);
  const urlY = BAR_Y + Math.round((BAR_H - 46) / 2) - 4;
  return (
    `[0:v]split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,setsar=1[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[bs];` +
    `[bs]drawbox=x=0:y=${BAR_Y}:w=${W}:h=${BAR_H}:color=${NAVY}@0.65:t=fill[bar];` +
    `[1:v]scale=300:-1[logo_s];color=white@0.92:size=${plateW}x${plateH}:r=30[plate];` +
    `[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[lb];` +
    `[bar][lb]overlay=44:${plateY}[wl];` +
    `[wl]drawtext=fontfile=${FONT}:text=ameublodirect.ca:fontcolor=${GOLD}:fontsize=46:borderw=1:bordercolor=black@0.4:x=W-text_w-56:y=${urlY}[vout]`
  );
}

function audioFilter(dur, hasAudio) {
  const st = Math.max(0.1, dur - 1).toFixed(2);
  const mus = `[2:a]volume=-12dB,afade=t=in:d=0.3,afade=t=out:st=${st}:d=1[mus]`;
  if (hasAudio) return `${mus};[0:a][mus]amix=inputs=2:duration=first:normalize=0[aout]`;
  return `${mus};[mus]anull[aout]`;
}

function render(clip, track, dur, hasAudio) {
  return new Promise((resolve) => {
    const src = `${IN_DIR}/${clip}`, out = `${OUT_DIR}\\${clip}`, tmp = `${OUT_DIR}\\.tmp-${clip}`;
    const args = [
      "-y", "-nostdin", "-loglevel", "error",
      "-i", src, "-loop", "1", "-i", LOGO, "-stream_loop", "-1", "-i", track,
      "-filter_complex", `${videoFilter()};${audioFilter(dur, hasAudio)}`,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", tmp,
    ];
    let err = "";
    const p = spawn(FFMPEG, args);
    p.stderr.on("data", (d) => (err += d));
    // Atomic: only promote tmp→final on clean exit. A killed encode leaves a
    // truncated .tmp that resume never mistakes for a finished output.
    p.on("close", (code) => {
      if (code === 0 && existsSync(tmp)) { try { renameSync(tmp, out); } catch {} }
      else { try { rmSync(tmp, { force: true }); } catch {} }
      resolve({ clip, out, code, err, track: path.basename(track), dur, hasAudio });
    });
  });
}

// VERIFY mode: ffprobe every output, delete any that is unreadable or >2s
// shorter than its source (truncated by an earlier kill), plus stray .tmp-*.
// Then a normal run regenerates the deleted ones.
if (process.env.VERIFY) {
  let bad = 0, ok = 0;
  for (const f of readdirSync(OUT_DIR)) {
    const full = `${OUT_DIR}\\${f}`;
    if (f.startsWith(".tmp-")) { rmSync(full, { force: true }); console.log(`rm stray ${f}`); continue; }
    if (!f.toLowerCase().endsWith(".mp4")) continue;
    const srcPath = `${IN_DIR}/${f}`;
    let outDur = NaN, srcDur = NaN;
    try { outDur = parseFloat(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", full], { encoding: "utf8" }).trim()); } catch {}
    try { srcDur = parseFloat(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", srcPath], { encoding: "utf8" }).trim()); } catch {}
    if (!isFinite(outDur) || (isFinite(srcDur) && outDur < srcDur - 2)) {
      rmSync(full, { force: true }); bad++;
      console.log(`✗ ${f.padEnd(20)} out=${isFinite(outDur) ? outDur.toFixed(1) : "??"}s src=${isFinite(srcDur) ? srcDur.toFixed(1) : "??"}s → SUPPRIMÉ`);
    } else ok++;
  }
  console.log(`\n=== VERIFY: ${ok} valides, ${bad} corrompus supprimés (à re-render) ===`);
  process.exit(0);
}

const clips = readdirSync(IN_DIR).filter((f) => f.toLowerCase().endsWith(".mp4")).sort();
const todo = clips.filter((c) => !(existsSync(`${OUT_DIR}\\${c}`) && statSync(`${OUT_DIR}\\${c}`).size > 20000));
console.log(`Total ${clips.length} | déjà rendus ${clips.length - todo.length} | à faire ${todo.length}\n`);

let idx = 0, done = 0, fail = 0;
async function worker() {
  for (;;) {
    const myIdx = idx++;
    if (myIdx >= todo.length) return;
    const clip = todo[myIdx];
    const track = TRACKS[myIdx % TRACKS.length];
    let meta;
    try { meta = probe(`${IN_DIR}/${clip}`); } catch (e) { console.log(`✗ ${clip.padEnd(20)} probe fail`); fail++; continue; }
    const r = await render(clip, track, meta.dur, meta.hasAudio);
    if (r.code === 0 && existsSync(r.out)) {
      done++;
      console.log(`▸ ${clip.padEnd(20)} ${meta.dur.toFixed(1)}s ${meta.hasAudio ? "a+mus" : "mus"} [${r.track}] → ${(statSync(r.out).size / 1048576).toFixed(1)} MB   (${done}/${todo.length})`);
    } else {
      fail++;
      console.log(`✗ ${clip.padEnd(20)} FAIL: ${r.err.slice(0, 200)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const remaining = readdirSync(IN_DIR).filter((f) => f.toLowerCase().endsWith(".mp4"))
  .filter((c) => !(existsSync(`${OUT_DIR}\\${c}`) && statSync(`${OUT_DIR}\\${c}`).size > 20000)).length;
console.log(`\n=== window done: ${done} rendus, ${fail} échecs | remaining: ${remaining} → ${OUT_DIR} ===`);
