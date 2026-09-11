#!/usr/bin/env tsx
/**
 * scripts/poc-assembly.mts — POC "satisfying / assemblage".
 *
 * NOT part of the production pipeline. Renders locally, uploads nothing, enqueues nothing.
 *
 * THE POINT OF THIS FORMAT
 * Some UGC clips show a box being opened and a piece of furniture going together. As a
 * product ad that footage fails — it is the reason the previous batch produced ads where the
 * thing being sold is barely visible. As organic content it is the good stuff, so this cuts
 * it once and gets out of the way.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY
 *   - no Ken Burns. A push-in on handheld assembly footage reads as a filter.
 *   - no Hormozi sequence, no price, no product name. The brief is explicit and it is right:
 *     the format lives on looking unproduced. A sales script over it kills exactly the thing
 *     that makes someone watch.
 *   - no navy brand bar. A small gold URL over a soft scrim is enough to say whose channel
 *     this is without turning the clip into an ad.
 *   - ONE trim. No multi-segment edit: the cut is chosen around the moment Vision actually
 *     saw assembly, and then the clip runs.
 *
 * WHAT IS KEPT: the music pool, so an assembly clip still sounds like its category.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
const FONT = process.env.SEQ_FONT ?? "fonts/DMSans.ttf";
const MUSIC_DIR = process.env.SEQ_MUSIC_DIR ?? "src/audio";
const CLIP_DIR = process.env.SEQ_CLIP_DIR ?? "src/ugc";
const W = 1080, H = 1920;
const GOLD = "0xD4A853";
const MIN_SEC = 10, MAX_SEC = 15;

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const OUT_DIR = flag("--out") ?? ".";
const CLIPS_FILE = flag("--clips") ?? "pocB-selected.json";

interface Clip {
  sku: string;
  product_type: string;
  /** Music family, only to label the output file so a batch is sortable by ear. */
  family?: string;
  /** Generic category wording. NEVER the product name — that is the whole rule here. */
  caption: string;
  /** Seconds into the source where Vision saw assembly. */
  at: number;
}

function duration(file: string): number {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number(String(out).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`no duration: ${file}`);
  return d;
}

/**
 * One cut, framed on the assembly moment.
 *
 * Centring the window on it would be wrong: assembly reads forward, so the interesting part
 * is what happens AFTER the moment Vision recognised. Start 1.5 s before and let it run.
 */
export function chooseTrim(dur: number, at: number): { start: number; length: number } {
  const length = Math.min(MAX_SEC, Math.max(MIN_SEC, Math.min(dur, MAX_SEC)));
  const start = Math.max(0, Math.min(at - 1.5, Math.max(0, dur - length)));
  return { start: Number(start.toFixed(2)), length: Number(Math.min(length, dur - start).toFixed(2)) };
}

async function captionPng(text: string, out: string): Promise<{ w: number; h: number }> {
  const sharp = (await import("sharp")).default;
  const { registerBrandFonts } = await import("@/lib/register-brand-fonts");
  registerBrandFonts();
  // SVG rather than drawtext so the emoji has a chance of a glyph: drawtext takes ONE font
  // file and has no fallback, so 🔨 renders as tofu there. librsvg goes through fontconfig
  // and can fall back to the bundled emoji face.
  const fontSize = 62;
  const w = 1000, h = 220;
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="26" fill="black" fill-opacity="0.42"/>` +
    `<text x="${w / 2}" y="${h / 2 + fontSize / 3}" text-anchor="middle" ` +
    `font-family="DM Sans, Noto Emoji, sans-serif" font-size="${fontSize}" font-weight="700" ` +
    `fill="white">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`;
  const info = await sharp(Buffer.from(svg)).png().toFile(out);
  return { w: info.width, h: info.height };
}

async function main(): Promise<void> {
  const C = await import("@/lib/video-ad-composer");
  const clips: Clip[] = JSON.parse(fs.readFileSync(CLIPS_FILE, "utf8"));
  const tracks = fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith(".mp3")).map((f) => path.join(MUSIC_DIR, f)).sort();
  console.log(`\n🔨 assemblage — ${clips.length} clips — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  for (const c of clips) {
    const safe = c.sku.replace(/[^A-Za-z0-9._-]/g, "_");
    const src = path.join(CLIP_DIR, `${c.sku}.mp4`);
    if (!fs.existsSync(src)) { console.log(`  ${c.sku} clip absent`); continue; }
    const dur = duration(src);
    const { start, length } = chooseTrim(dur, c.at);
    const music = C.pickMusic(c.sku, tracks, c.product_type);
    console.log(
      `  ${c.sku.padEnd(14)} source ${dur.toFixed(1)}s -> coupe ${start}s..${(start + length).toFixed(2)}s (${length}s)` +
        `  bed=${path.basename(music.track)} (${music.family})  « ${c.caption} »`,
    );
    if (!APPLY) continue;

    const dir = `tmp_poc_asm/${safe}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const cap = `${dir}/cap.png`;
      const { h: capH } = await captionPng(c.caption, cap);
      const capY = Math.round(H * 0.13);
      const vol = Number((0.22 * (music.gain ?? 1)).toFixed(3));

      const graph =
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base];` +
        `[2:v]format=rgba[cap];` +
        `[base][cap]overlay=(W-w)/2:${capY}[capped];` +
        // Just enough scrim under the URL to keep it legible on a bright frame.
        `[capped]drawbox=x=0:y=${H - 120}:w=${W}:h=120:color=black@0.30:t=fill[scrim];` +
        `[scrim]drawtext=fontfile=${FONT}:text=ameublodirect.ca:fontcolor=${GOLD}:fontsize=44:` +
        `x=(w-text_w)/2:y=${H - 88},fade=t=in:d=0.3,fade=t=out:st=${(length - 0.5).toFixed(2)}:d=0.5,` +
        `setsar=1,format=yuv420p[vout];` +
        `[1:a]atempo=${music.tempo},volume=${vol},afade=t=in:d=0.6,` +
        `afade=t=out:st=${Math.max(0, length - 1.4).toFixed(2)}:d=1.4:curve=par[aout]`;
      const graphFile = `${dir}/graph.txt`;
      fs.writeFileSync(graphFile, graph, "utf8");

      const out = path.join(OUT_DIR, `ASM-${c.family ?? music.family.split(" ")[0]}-${safe}.mp4`);
      const args = [
        "-y", "-nostdin", "-loglevel", "error",
        "-ss", String(start), "-t", String(length), "-i", src,
        "-stream_loop", "-1", "-ss", String(music.startOffset), "-i", music.track,
        "-i", cap,
        "-t", String(length),
        "-filter_complex_script", graphFile, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ];
      try {
        execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        const se = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
        throw new Error(`ffmpeg ${c.sku}: ${se.slice(-1200) || (e as Error).message.slice(-400)}`);
      }
      void capH;
      console.log(`    ↳ ${out}`);
    } finally {
      if (!process.env.SEQ_KEEP_GRAPH) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!APPLY) console.log("\nDry-run. --apply pour rendre.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\nFATAL:", e); process.exit(1); });
