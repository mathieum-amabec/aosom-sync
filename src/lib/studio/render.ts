/**
 * Studio Avant/Après renderer — two stills (Mat's picks) → branded MP4, on the Vercel Node
 * runtime (ffmpeg-static) or locally (FFMPEG_BIN).
 *
 * Visual language is the validated before_after v3 design from scripts/batch-before-after.mts
 * (slow Ken Burns on each still, cinematic grade, navy brand bar + logo plate, AVANT/APRÈS
 * labels with a gold underline, fade-out), generalised over Mat's choices: transition, format,
 * duration, music, and optional title / price / CTA texts.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FORMATS, getTransition, studioTimeline, type StudioRenderRequest, type ImageFit } from "./options";

const execFileAsync = promisify(execFile);

export const STUDIO_FPS = 30;
const NAVY = "0x1A2340";
const GOLD = "0xD4A853";
const GRADE = "curves=preset=medium_contrast,eq=saturation=1.12:contrast=1.03";
/** Relative to process.cwd(): traced into the /api/studio/render function by next.config.ts. */
export const STUDIO_FONT = "src/fonts/DMSans-Bold.ttf";
export const STUDIO_LOGO = "Logo/officiel-transparent.png";

/** Escape a filesystem path for use as a filtergraph option value (Windows drive colons, backslashes). */
export function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export interface GraphInput {
  w: number;
  h: number;
  durationSec: number;
  transition: { kind: "slider" | "xfade"; xfade: string; duration: number };
  /** Absolute/relative paths of text files already written (drawtext textfile=). */
  textFiles: { before?: string; after?: string; title?: string; price?: string; cta?: string; domain: string };
  font: string;
  hasMusic: boolean;
  /** Input indexes: 0 before still, 1 after still, 2 logo, 3 audio (music or anullsrc). */
}

/**
 * Build the full filter_complex (video + audio) for a render. Pure: same input → same string,
 * so the timeline and every overlay can be unit-tested without running ffmpeg.
 */
export function buildStudioGraph(g: GraphInput): string {
  const { w: W, h: H, durationSec: D } = g;
  const T = g.transition.duration;
  const tl = studioTimeline(D, T);
  const font = filterPath(g.font);
  const tf = (p: string) => filterPath(p);
  const fA = Math.round(tl.beforeSec * STUDIO_FPS);
  const fB = Math.round(tl.afterSec * STUDIO_FPS);
  const zoomOut = (frames: number) =>
    `zoompan=z='1.06-0.06*on/${frames - 1}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${STUDIO_FPS}`;
  const zoomIn = (frames: number) =>
    `zoompan=z='1+0.06*on/${frames - 1}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${STUDIO_FPS}`;

  const parts: string[] = [];
  parts.push(`[0:v]${zoomOut(fA)},setsar=1,format=yuv420p[a]`);
  parts.push(`[1:v]${zoomIn(fB)},setsar=1,format=yuv420p[b]`);
  parts.push(`[a][b]xfade=transition=${g.transition.xfade}:duration=${T.toFixed(2)}:offset=${tl.transitionStart.toFixed(2)}[x]`);
  let cur = "x";
  if (g.transition.kind === "slider") {
    // Divider line riding the wipe edge (wiperight reveals the AFTER from the left edge).
    const lineW = 10;
    parts.push(`color=c=white:s=${lineW}x${H}:r=${STUDIO_FPS}[line]`);
    const x = `if(between(t\\,${tl.transitionStart.toFixed(2)}\\,${tl.transitionEnd.toFixed(2)})\\,(t-${tl.transitionStart.toFixed(2)})/${T.toFixed(2)}*${W}-${lineW / 2}\\,-${lineW * 3})`;
    parts.push(`[${cur}][line]overlay=x='${x}':y=0:shortest=1[sl]`);
    cur = "sl";
  }
  parts.push(`[${cur}]${GRADE}[graded]`);

  // Brand bar + logo plate + domain.
  const BAR_H = Math.round(H * 0.0885);
  const barY = H - BAR_H;
  const plateH = Math.round(BAR_H * 0.52), plateW = Math.round(plateH * 3.86);
  const plateY = barY + Math.round((BAR_H - plateH) / 2);
  parts.push(`[graded]drawbox=x=0:y=${barY}:w=${W}:h=${BAR_H}:color=${NAVY}@0.78:t=fill[bar]`);
  parts.push(`[2:v]scale=${Math.round(plateW * 0.88)}:-1[logo_s]`);
  parts.push(`color=white@0.92:size=${plateW}x${plateH}:r=${STUDIO_FPS}[plate]`);
  parts.push(`[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[lb]`);
  parts.push(`[bar][lb]overlay=44:${plateY}[wl]`);
  const domainFs = Math.round(BAR_H * 0.27);
  parts.push(`[wl]drawtext=fontfile=${font}:textfile=${tf(g.textFiles.domain)}:fontcolor=${GOLD}:fontsize=${domainFs}:x=W-text_w-52:y=${barY}+(${BAR_H}-text_h)/2[branded]`);

  const draws: string[] = [];
  const between = (a: number, b: number) => `between(t\\,${a.toFixed(2)}\\,${b.toFixed(2)})`;

  // Title (top), on a navy backing box.
  if (g.textFiles.title) {
    const fs = Math.round(W * 0.052);
    draws.push(
      `drawtext=fontfile=${font}:textfile=${tf(g.textFiles.title)}:fontcolor=white:fontsize=${fs}:box=1:boxcolor=${NAVY}@0.72:boxborderw=22:x=(w-text_w)/2:y=${Math.round(H * 0.07)}`,
    );
  }

  // AVANT / APRÈS labels with a gold underline that grows in.
  if (g.textFiles.before && g.textFiles.after) {
    const labelFs = Math.round(W * 0.092);
    const labelY = Math.round(H * 0.6);
    const windows: [string, number, number][] = [
      [g.textFiles.before, 0.25, tl.transitionStart],
      [g.textFiles.after, tl.transitionEnd, D - 0.35],
    ];
    for (const [file, s0, e0] of windows) {
      if (e0 - s0 < 0.3) continue;
      const alpha = `min(1\\,max(0\\,(t-${s0.toFixed(2)})/0.3))`;
      draws.push(
        `drawtext=fontfile=${font}:textfile=${tf(file)}:fontcolor=white:fontsize=${labelFs}:borderw=3:bordercolor=black@0.5:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${labelY}:alpha='${alpha}':enable='${between(s0, e0)}'`,
      );
      draws.push(
        `drawbox=x=${Math.round((W - 380) / 2)}:y=${labelY + Math.round(labelFs * 1.2)}:w=380:h=6:color=${GOLD}:t=fill:enable='${between(s0 + 0.15, e0)}'`,
      );
    }
  }

  // Price (white, large) and CTA (gold pill) just above the brand bar, shown on the AFTER.
  const afterFrom = tl.transitionEnd;
  if (g.textFiles.price) {
    const fs = Math.round(W * 0.068);
    draws.push(
      `drawtext=fontfile=${font}:textfile=${tf(g.textFiles.price)}:fontcolor=white:fontsize=${fs}:borderw=3:bordercolor=black@0.55:x=(w-text_w)/2:y=${barY - Math.round(H * 0.155)}:enable='${between(afterFrom, D)}'`,
    );
  }
  if (g.textFiles.cta) {
    const fs = Math.round(W * 0.036);
    draws.push(
      `drawtext=fontfile=${font}:textfile=${tf(g.textFiles.cta)}:fontcolor=${NAVY}:fontsize=${fs}:box=1:boxcolor=${GOLD}@1:boxborderw=18:x=(w-text_w)/2:y=${barY - Math.round(H * 0.065)}`,
    );
  }

  const chain = [...draws, `fade=t=out:st=${(D - 0.4).toFixed(2)}:d=0.4`, "setsar=1", "format=yuv420p"].join(",");
  parts.push(`[branded]${chain}[vout]`);

  const audio = g.hasMusic
    ? `[3:a]volume=0.25,afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, D - 1.2).toFixed(2)}:d=1.2[aout]`
    : `[3:a]anull[aout]`;
  parts.push(audio);
  return parts.join(";\n");
}

/** Resolve ffmpeg: FFMPEG_BIN/FFMPEG_PATH → ffmpeg-static → PATH (same order as the slideshow engine). */
export async function resolveStudioFfmpeg(): Promise<string> {
  const override = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH;
  if (override) return override;
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string | null };
    if (mod.default) return mod.default;
  } catch {
    // no binary for this platform — fall through to PATH
  }
  return "ffmpeg";
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url.slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fit an image onto the W×H canvas: whole product over a blurred copy (contain) or full-bleed crop (cover). */
export async function prepareStill(buf: Buffer, fit: ImageFit, W: number, H: number, out: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const src = sharp(buf).rotate();
  if (fit === "cover") {
    await src.resize(W, H, { fit: "cover", position: "attention" }).png().toFile(out);
    return;
  }
  const oriented = await src.toBuffer();
  const bg = await sharp(oriented).resize(W, H, { fit: "cover", position: "centre" }).blur(45).modulate({ brightness: 0.55 }).toBuffer();
  const fg = await sharp(oriented)
    .resize(Math.round(W * 0.91), Math.round(H * 0.8), { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp(bg).composite([{ input: fg, gravity: "center" }]).png().toFile(out);
}

const LABELS = { fr: ["AVANT", "APRÈS"], en: ["BEFORE", "AFTER"] } as const;
const DOMAIN = { fr: "ameublodirect.ca", en: "furnishdirect.ca" } as const;

/**
 * Render a Studio request to `outFile`. `workDir` must be writable (use /tmp on Vercel).
 * Throws with a readable message on any failure; cleans its temp files either way.
 */
export async function renderStudioVideo(req: StudioRenderRequest, workDir: string, outFile: string): Promise<void> {
  const { w: W, h: H } = FORMATS[req.format];
  const transition = getTransition(req.transition);
  if (!transition) throw new Error(`Transition inconnue : ${req.transition}`);
  await mkdir(workDir, { recursive: true });
  try {
    const [beforeBuf, afterBuf] = await Promise.all([download(req.before.url), download(req.after.url)]);
    const beforePng = path.join(workDir, "before.png");
    const afterPng = path.join(workDir, "after.png");
    await Promise.all([prepareStill(beforeBuf, req.before.fit, W, H, beforePng), prepareStill(afterBuf, req.after.fit, W, H, afterPng)]);

    const write = async (name: string, text: string) => {
      const p = path.join(workDir, name);
      await writeFile(p, text, "utf8");
      return p;
    };
    const [labelBefore, labelAfter] = LABELS[req.locale];
    const textFiles = {
      domain: await write("domain.txt", DOMAIN[req.locale]),
      before: req.texts.labels ? await write("before.txt", labelBefore) : undefined,
      after: req.texts.labels ? await write("after.txt", labelAfter) : undefined,
      title: req.texts.title ? await write("title.txt", req.texts.title) : undefined,
      price: req.texts.price ? await write("price.txt", req.texts.price) : undefined,
      cta: req.texts.cta ? await write("cta.txt", req.texts.cta) : undefined,
    };

    let musicFile: string | null = null;
    if (req.musicUrl) {
      musicFile = path.join(workDir, "music.mp3");
      await writeFile(musicFile, await download(req.musicUrl));
    }

    const tl = studioTimeline(req.durationSec, transition.duration);
    const graph = buildStudioGraph({
      w: W,
      h: H,
      durationSec: req.durationSec,
      transition,
      textFiles,
      font: STUDIO_FONT,
      hasMusic: !!musicFile,
    });
    const graphFile = path.join(workDir, "graph.txt");
    await writeFile(graphFile, graph, "utf8");

    const audioInput = musicFile
      ? ["-stream_loop", "-1", "-ss", String(req.musicStartSec), "-i", musicFile]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
    const args = [
      "-y", "-nostdin", "-loglevel", "error",
      "-loop", "1", "-t", tl.beforeSec.toFixed(2), "-i", beforePng,
      "-loop", "1", "-t", tl.afterSec.toFixed(2), "-i", afterPng,
      "-i", STUDIO_LOGO,
      ...audioInput,
      "-t", String(req.durationSec),
      "-filter_complex_script", graphFile,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "21", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
      outFile,
    ];
    const ffmpeg = await resolveStudioFfmpeg();
    try {
      await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw new Error(`Rendu ffmpeg échoué${stderr ? ` : ${stderr.slice(-400)}` : ""}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
