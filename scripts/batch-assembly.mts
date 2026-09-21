#!/usr/bin/env tsx
/**
 * scripts/batch-assembly.mts — Assembly batch pipeline (content-scale chantier).
 *
 * CORRECTION (Problem 3, this session): the 3 assembly clips shipped for review used
 * poc-assembly-v3.mts's caption placement verbatim — top, static, navy/gold, but LEFT-anchored
 * (drawbox at x=40, drawtext at x=80), never actually centered. On inspection there was no
 * separate/regressed script: it is the very same v3 render, it was simply never centered in
 * the first place. This script fixes that (both the pill and the text now center horizontally)
 * and is the one going forward for this format — poc-assembly-v3.mts stays as the historical
 * POC, not touched.
 *
 * Renders the same jump-cut / wipeleft / grade design as v3 — see poc-assembly-v3.mts's
 * header for that history. DRAFT ONLY.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
const FONT = "fonts/DMSans.ttf";
const MUSIC_DIR = "src/audio";
const CLIP_DIR = "src/ugc";
const W = 1080, H = 1920;
const NAVY = "0x1A2340", GOLD = "0xD4A853";
const CUT = 0.18;
const GRADE = "curves=preset=medium_contrast,eq=saturation=1.12:contrast=1.03";

for (const [label, p] of [["Font", FONT]] as const) {
  if (!existsSync(p)) { console.error(`✗ ${label} not found: ${p}`); process.exit(1); }
}

interface Clip { sku: string; product_type: string; family?: string; caption: string; at: number }
interface Seg { start: number; len: number }

function duration(file: string): number {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number(String(out).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`no duration: ${file}`);
  return d;
}

export function chooseJumpCuts(dur: number, at: number): Seg[] {
  const skip = dur > 30 ? 2.0 : dur > 20 ? 1.5 : 1.2;
  const s1len = 2.3, s2len = 4.5, s3len = 4.7;
  const s1start = Math.max(0, at - 1.2);
  const s1end = Math.min(dur, s1start + s1len);
  const s2start = Math.min(dur, s1end + skip);
  const s2end = Math.min(dur, s2start + s2len);
  const s3start = Math.min(dur, s2end + skip);
  const s3end = Math.min(dur, s3start + s3len);
  return [
    { start: s1start, len: s1end - s1start },
    { start: s2start, len: s2end - s2start },
    { start: s3start, len: s3end - s3start },
  ].filter((s) => s.len > 0.3);
}

function buildGraph(dir: string, segs: Seg[], caption: string): { graph: string; total: number } {
  const scaleCrop = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p`;
  const parts: string[] = [];
  segs.forEach((_, i) => parts.push(`[${i}:v]${scaleCrop}[s${i}]`));

  let chain = "s0";
  let running = segs[0].len;
  for (let i = 1; i < segs.length; i++) {
    const next = `x${i}`;
    const offset = (running - CUT).toFixed(2);
    parts.push(`[${chain}][s${i}]xfade=transition=wipeleft:duration=${CUT}:offset=${offset}[${next}]`);
    running = running - CUT + segs[i].len;
    chain = next;
  }
  const total = running;

  parts.push(`[${chain}]${GRADE}[graded]`);

  // CORRECTION ROUND 2: round 1 centered the PILL correctly (pillX math below is right — a
  // fresh render was measured against a drawn true-center line at iw/2 to confirm), but the
  // multi-line TEXT still drifted off-center. Root cause: a single drawtext call given a
  // multi-line textfile centers the BOUNDING BOX OF THE WIDEST LINE via x=(w-text_w)/2 — every
  // OTHER (shorter) line is left-justified inside that box, not independently centered, so a
  // 2-line caption with lines of different lengths shows its shorter line visibly off-center.
  // Fixed by emitting one drawtext call PER LINE, each with its own x=(w-text_w)/2 — text_w is
  // then that line's own width, so every line centers independently on the true 1080px frame.
  const lines = caption.split("\n");
  const maxLineLen = Math.max(...lines.map((l) => l.length));
  const pillW = Math.min(1000, 70 + maxLineLen * 25);
  const pillH = lines.length > 1 ? 150 : 76;
  const capY = Math.round(H * 0.12);
  const pillX = Math.round((W - pillW) / 2);
  const fontSize = 44;
  const lineGap = Math.round(fontSize * 1.25);
  const textStartY = capY + (lines.length > 1 ? 24 : 16);

  const draws: string[] = [
    `drawbox=x=${pillX}:y=${capY}:w=${pillW}:h=${pillH}:color=${NAVY}@0.6:t=fill`,
  ];
  lines.forEach((line, i) => {
    const f = `${dir}/cap${i}.txt`;
    writeFileSync(f, line, "utf8");
    draws.push(
      `drawtext=fontfile=${FONT}:textfile=${f}:fontcolor=${GOLD}:fontsize=${fontSize}:` +
        `borderw=2:bordercolor=black@0.35:x=(w-text_w)/2:y=${textStartY + i * lineGap}`,
    );
  });

  const urlY = H - 92;
  parts.push(
    `[graded]${draws.join(",")},` +
      `drawtext=fontfile=${FONT}:text=ameublodirect.ca:fontcolor=${GOLD}:fontsize=40:` +
      `x=(w-text_w)/2:y=${urlY},fade=t=in:d=0.3,fade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5,` +
      `setsar=1,format=yuv420p[vout]`,
  );
  return { graph: parts.join(";"), total };
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const OUT_DIR = flag("--out") ?? "out_assembly";
const CLIPS_FILE = flag("--clips") ?? "assemblyBatch.json";

async function main(): Promise<void> {
  const { addToQueue } = await import("@/lib/database");
  const { put } = await import("@vercel/blob");
  const { pickMusic } = await import("@/lib/video-ad-composer");
  const clips: Clip[] = JSON.parse(readFileSync(CLIPS_FILE, "utf8"));
  const tracks = readdirSync(MUSIC_DIR).filter((f) => f.endsWith(".mp3")).map((f) => path.join(MUSIC_DIR, f));
  console.log(`\n🔨 assembly batch — ${clips.length} clips — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  for (const c of clips) {
    const src = path.join(CLIP_DIR, `${c.sku}.mp4`);
    if (!existsSync(src)) { console.log(`  ${c.sku} clip absent`); continue; }
    const dur = duration(src);
    const segs = chooseJumpCuts(dur, c.at);
    const music = pickMusic(c.sku, tracks, c.product_type);
    console.log(`  ${c.sku.padEnd(14)} segs=${segs.map((s) => `${s.start.toFixed(1)}-${(s.start + s.len).toFixed(1)}`).join(" | ")}`);
    if (!APPLY) continue;

    const dir = `tmp_asm_batch/${c.sku}`;
    mkdirSync(dir, { recursive: true });
    try {
      const { graph, total } = buildGraph(dir, segs, c.caption);
      const vol = Number((0.22 * (music.gain ?? 1)).toFixed(3));
      const audioIdx = segs.length;
      const audio = `[${audioIdx}:a]atempo=${music.tempo},volume=${vol},afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, total - 1.4).toFixed(2)}:d=1.4:curve=par[aout]`;
      const graphFile = `${dir}/graph.txt`;
      writeFileSync(graphFile, `${graph};${audio}`, "utf8");

      const fam = c.family ?? music.family?.split(" ")[0] ?? "x";
      const outFile = path.join(OUT_DIR, `ASM-${fam}-${c.sku}.mp4`);
      mkdirSync(OUT_DIR, { recursive: true });
      const args = ["-y", "-nostdin", "-loglevel", "error"];
      for (const s of segs) args.push("-ss", String(s.start), "-t", String(s.len), "-i", src);
      args.push("-stream_loop", "-1", "-ss", String(music.startOffset), "-i", music.track);
      args.push(
        "-t", String(total),
        "-filter_complex_script", graphFile, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outFile,
      );
      execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      const fileBuf = readFileSync(outFile);
      const { url } = await put(`content-batches/assembly/ASM-${fam}-${c.sku}.mp4`, fileBuf, {
        access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
      });

      // Cancel any prior draft row for this SKU (the mis-positioned v3 registration) so the
      // dashboard doesn't show both the broken and the fixed clip.
      const db = await import("@/lib/database");
      await (db as unknown as { ensureSchema: () => Promise<import("@libsql/client").Client> }).ensureSchema().then((client) =>
        client.execute({
          sql: `UPDATE publication_queue SET status='cancelled' WHERE content_type='assembly' AND content_id=? AND status='draft'`,
          args: [c.sku],
        }),
      );

      await addToQueue({
        contentType: "assembly",
        contentId: c.sku,
        platform: "facebook",
        payload: JSON.stringify({ sku: c.sku, productName: c.caption.replace("\n", " "), blobUrl: url }),
        scheduledAt: `2026-12-31 ${String(Math.floor(Math.random() * 23)).padStart(2, "0")}:00:00`,
        status: "draft",
        metadata: { source: "batch-assembly-centered-fix" },
      });
      console.log(`    ↳ ✓ ${url}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
