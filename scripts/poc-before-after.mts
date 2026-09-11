#!/usr/bin/env tsx
/**
 * scripts/poc-before-after.mts — POC "avant / après", two stills instead of a clip.
 *
 * NOT part of the production pipeline. Renders locally, uploads nothing, enqueues nothing.
 *
 * WHAT "AVANT / APRÈS" ACTUALLY IS HERE
 * There is no empty-room-vs-furnished pair anywhere in the assets — nobody shot one. What we
 * do have on every lifestyle-verified product is a studio shot on white and a staged shot in
 * a room, and the contrast between those two IS the before/after: the object as a catalogue
 * entry, then the object as part of a home. Both images are picked by Claude Vision rather
 * than by position, because position 1 is not reliably the lifestyle shot (measured: two of
 * the first three lifestyle-verified products tested had a white background at position 1).
 *
 * WHAT IS REUSED FROM v3
 *   - the Ken Burns push, but mirrored: the studio shot pulls OUT (the object receding into
 *     a catalogue) and the room shot pushes IN (settling into the space). Same motion budget,
 *     opposite directions, so the cut between them reads as a change of state.
 *   - the brand bar, plate, logo and gold keyline.
 *   - the music pool: family by product_type, level-matched by TRACK_GAIN.
 *
 * WHAT IS DELIBERATELY NOT REUSED
 *   - the word-by-word hook and the four-message Hormozi sequence. Two labels carry this
 *     format; a sales script over a two-image comparison fights the comparison.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FONT = process.env.SEQ_FONT ?? "fonts/DMSans.ttf";
const LOGO = process.env.SEQ_LOGO ?? "Logo/officiel-transparent.png";
const MUSIC_DIR = process.env.SEQ_MUSIC_DIR ?? "src/audio";
const W = 1080, H = 1920, FPS = 30;
const NAVY = "0x1A2340", GOLD = "0xD4A853";
const BAR_H = 170;
/** Per still, before the crossfade. Two of these minus the transition is the total. */
const STILL_SEC = 4.75;
const XFADE_SEC = 0.5;
const TOTAL = STILL_SEC * 2 - XFADE_SEC; // 9.0

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const OUT_DIR = flag("--out") ?? ".";
const PAIRS_FILE = flag("--pairs") ?? "pocA-pairs.json";

interface Pair {
  sku: string; name: string; price: number; product_type: string;
  studio: string; life: string; cat: string;
}

async function prepare(url: string, out: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  // Cover-crop to the full 9:16 so the Ken Burns push has real pixels to move into.
  await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).png().toFile(out);
}

function esc(e: string): string {
  return e.replace(/,/g, "\\,");
}

function build(dir: string, labels: [string, string], musicIdx: number): string {
  const barY = H - BAR_H;
  const plateH = 88, plateW = 340;
  const plateY = barY + Math.round((BAR_H - plateH) / 2);
  const urlY = barY + Math.round((BAR_H - 46) / 2) - 4;
  const d = Math.round(STILL_SEC * FPS);

  // Mirrored Ken Burns: out on the studio shot, in on the room shot.
  const kbOut = `zoompan=z='1.08-0.08*on/${d - 1}':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;
  const kbIn = `zoompan=z='1+0.08*on/${d - 1}':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;

  const parts: string[] = [];
  parts.push(`[0:v]${kbOut},setsar=1,format=yuv420p[a]`);
  parts.push(`[1:v]${kbIn},setsar=1,format=yuv420p[b]`);
  parts.push(`[a][b]xfade=transition=fade:duration=${XFADE_SEC}:offset=${(STILL_SEC - XFADE_SEC).toFixed(2)}[x]`);
  // A light scrim only under the label band; the point of this format is the photo.
  parts.push(`[x]drawbox=x=0:y=${Math.round(H * 0.62)}:w=${W}:h=${Math.round(H * 0.18)}:color=black@0.38:t=fill[scrim]`);
  parts.push(`[scrim]drawbox=x=0:y=${barY}:w=${W}:h=${BAR_H}:color=${NAVY}@0.72:t=fill[bar]`);
  parts.push(`[${musicIdx + 1}:v]scale=300:-1[logo_s]`);
  parts.push(`color=white@0.92:size=${plateW}x${plateH}:r=${FPS}[plate]`);
  parts.push(`[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[lb]`);
  parts.push(`[bar][lb]overlay=44:${plateY}[wl]`);
  parts.push(
    `[wl]drawtext=fontfile=${FONT}:text=ameublodirect.ca:fontcolor=${GOLD}:fontsize=46:` +
      `borderw=1:bordercolor=black@0.4:x=W-text_w-56:y=${urlY}[branded]`,
  );

  // Two labels, each fading in and sliding up 60 px over 0.35 s. The second is timed to the
  // END of the crossfade, so the word lands on the new image rather than through the blend.
  const draws: string[] = [];
  const labelY = Math.round(H * 0.665);
  const windows: [number, number][] = [
    [0.25, STILL_SEC - XFADE_SEC],
    [STILL_SEC, TOTAL],
  ];
  labels.forEach((text, i) => {
    const [s0, e0] = windows[i];
    const f = `${dir}/label${i}.txt`;
    fs.writeFileSync(f, text, "utf8");
    const p = esc(`min(1,max(0,(t-${s0.toFixed(2)})/0.35))`);
    const ease = esc(`(1-pow(1-min(1,max(0,(t-${s0.toFixed(2)})/0.35)),2))`);
    draws.push(
      `drawtext=fontfile=${FONT}:textfile=${f}:fontcolor=white:fontsize=104:` +
        `borderw=3:bordercolor=black@0.5:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
        `x=(w-text_w)/2:y='${labelY}+(1-${ease})*60':alpha='${p}':` +
        `enable='${esc(`between(t,${s0.toFixed(2)},${e0.toFixed(2)})`)}'`,
    );
    // Gold keyline wipes open under each label — the one v3 device that carries over.
    draws.push(
      `drawbox=x='(${W}-420*${p})/2':y=${labelY + 130}:w='420*${p}':h=6:color=${GOLD}:t=fill:` +
        `enable='${esc(`between(t,${s0.toFixed(2)},${e0.toFixed(2)})`)}'`,
    );
  });

  parts.push(
    `[branded]${draws.join(",")},fade=t=out:st=${(TOTAL - 0.4).toFixed(2)}:d=0.4,setsar=1,format=yuv420p[vout]`,
  );
  return parts.join(";");
}

async function main(): Promise<void> {
  const C = await import("@/lib/video-ad-composer");
  const pairs: Pair[] = JSON.parse(fs.readFileSync(PAIRS_FILE, "utf8"));
  const tracks = fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith(".mp3")).map((f) => path.join(MUSIC_DIR, f)).sort();
  console.log(`\n🖼️  avant/après — ${pairs.length} produits — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  for (const p of pairs) {
    const safe = p.sku.replace(/[^A-Za-z0-9._-]/g, "_");
    const dir = `tmp_poc_ba/${safe}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const music = C.pickMusic(p.sku, tracks, p.product_type);
      console.log(
        `  ${p.sku.padEnd(14)} ${p.cat.slice(0, 26).padEnd(28)} bed=${path.basename(music.track)} @${music.startOffset}s x${music.tempo} (${music.family})`,
      );
      if (!APPLY) continue;

      const a = `${dir}/a.png`, b = `${dir}/b.png`;
      await prepare(p.studio, a);
      await prepare(p.life, b);

      const graph = build(dir, ["AVANT", "APRÈS"], 2);
      const vol = Number((0.22 * (music.gain ?? 1)).toFixed(3));
      const audio =
        `[2:a]atempo=${music.tempo},volume=${vol},afade=t=in:d=0.6,` +
        `afade=t=out:st=${(TOTAL - 1.4).toFixed(2)}:d=1.4:curve=par[aout]`;
      const graphFile = `${dir}/graph.txt`;
      fs.writeFileSync(graphFile, `${graph};${audio}`, "utf8");

      const out = path.join(OUT_DIR, `AB-${safe}.mp4`);
      const args = [
        "-y", "-nostdin", "-loglevel", "error",
        "-loop", "1", "-t", String(STILL_SEC), "-i", a,
        "-loop", "1", "-t", String(STILL_SEC), "-i", b,
        "-stream_loop", "-1", "-ss", String(music.startOffset), "-i", music.track,
        "-i", LOGO,
        "-t", String(TOTAL),
        "-filter_complex_script", graphFile, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ];
      try {
        execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        const se = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
        throw new Error(`ffmpeg ${p.sku}: ${se.slice(-1200) || (e as Error).message.slice(-400)}`);
      }
      console.log(`    ↳ ${out}`);
    } finally {
      if (!process.env.SEQ_KEEP_GRAPH) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!APPLY) console.log("\nDry-run. --apply pour rendre.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\nFATAL:", e); process.exit(1); });
