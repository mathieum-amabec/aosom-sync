/**
 * "Ameublo présente" — overlays the mascot on an existing vertical video, for free.
 *
 * He pops up in the bottom corner, waves, points at a speech bubble while it is up, then
 * waves goodbye. Every frame is drawn from the parametric SVG (ameublo-sprite.ts), rasterised
 * by sharp and laid over the clip by ffmpeg: no AI call, no per-video cost, and the
 * character is identical in every video.
 *
 * Opt-in only (render-sequential-ads.mts `--ameublo`): nothing calls this by default.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ameubloPoseAt,
  ameubloSvg,
  defaultChoreography,
  type AmeubloAccessory,
  type Choreography,
} from "@/lib/ameublo-sprite";

export interface AmeubloOverlayOptions {
  ffmpegBin: string;
  /** DM Sans (or any TTF) for the bubble text. */
  fontFile: string;
  /** Text in the bubble, already uppercased. Omit for no bubble (he still waves). */
  bubbleText?: string;
  accessory?: AmeubloAccessory;
  /** Which side. Right by default. */
  corner?: "right" | "left";
  /**
   * Top or bottom of the frame. The sequential ads put their copy in a bottom band (or a top
   * band when the product sits low), so the caller passes the half the copy is NOT in.
   */
  vertical?: "top" | "bottom";
  /** Pixels kept free at the bottom when vertical = "bottom" (the ads' brand bar). */
  bottomMargin?: number;
  fps?: number;
}

export interface OverlayLayout {
  width: number;
  height: number;
  sprite: number;
  spriteX: number;
  spriteY: number;
  bubbleW: number;
  bubbleH: number;
  bubbleX: number;
  bubbleY: number;
  fontSize: number;
}

/** Geometry for a W×H clip. Pure, so the placement is unit-tested without ffmpeg. */
export function overlayLayout(
  width: number,
  height: number,
  opts: Pick<AmeubloOverlayOptions, "corner" | "vertical" | "bottomMargin">,
  bubbleText = "",
): OverlayLayout {
  const sprite = Math.round(width * 0.36);
  const margin = Math.round(width * 0.02);
  const spriteX = opts.corner === "left" ? margin : width - sprite - margin;
  const spriteY = opts.vertical === "top"
    ? Math.round(height * 0.05)
    : height - (opts.bottomMargin ?? Math.round(height * 0.09)) - sprite + Math.round(sprite * 0.06); // feet on the bar
  const fontSize = Math.round(width * 0.04);
  // Width follows the text: ~0.6 em per glyph in DM Sans caps, plus padding, capped.
  const bubbleW = Math.min(Math.round(width * 0.62), Math.round(bubbleText.length * fontSize * 0.64 + fontSize * 2));
  const bubbleH = Math.round(fontSize * 2.6);
  const bubbleX = opts.corner === "left"
    ? spriteX + Math.round(sprite * 0.85)
    : spriteX - bubbleW + Math.round(sprite * 0.15);
  // Beside his head, tail pointing down at him: works whether he stands at the top or the bottom.
  const bubbleY = Math.max(0, spriteY + Math.round(sprite * 0.12));
  return { width, height, sprite, spriteX, spriteY, bubbleW, bubbleH, bubbleX, bubbleY, fontSize };
}

/** White rounded bubble with a tail toward Ameublo, as an SVG (rasterised by sharp). */
export function bubbleSvg(w: number, h: number, corner: "right" | "left" = "right"): string {
  const tail = Math.round(h * 0.32);
  const body = h - tail;
  const rad = Math.round(body * 0.42);
  const tx = corner === "right" ? w - Math.round(w * 0.14) : Math.round(w * 0.14);
  const dir = corner === "right" ? 1 : -1;
  // Tail stroked first, body over it, then the tail's fill again (no stroke) to erase the seam.
  const tailPath = `M${tx - 18 * dir} ${body - 8} L${tx + 14 * dir} ${h - 3} L${tx + 8 * dir} ${body - 8} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<path d="${tailPath}" fill="#fff" stroke="#1b2a47" stroke-width="4" stroke-linejoin="round"/>` +
    `<rect x="3" y="3" width="${w - 6}" height="${body - 6}" rx="${rad}" fill="#fff" stroke="#1b2a47" stroke-width="4"/>` +
    `<path d="${tailPath}" fill="#fff" transform="translate(0 -3)"/>` +
    `</svg>`;
}

/** Duration (s) and size of a clip, read from ffmpeg's banner — no ffprobe dependency. */
export function probeClip(ffmpegBin: string, file: string): { duration: number; width: number; height: number } {
  const res = spawnSync(ffmpegBin, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const out = `${res.stderr ?? ""}`;
  const d = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const s = out.match(/Video:.*?(\d{3,5})x(\d{3,5})/);
  if (!d || !s) throw new Error(`cannot probe ${file}`);
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: Number(s[1]),
    height: Number(s[2]),
  };
}

/** The filter graph. Inputs: 0 = clip, 1 = Ameublo frame sequence, 2 = bubble PNG (looped). */
export function buildOverlayGraph(
  L: OverlayLayout,
  ch: Choreography,
  textFile: string | null,
  fontFile: string,
): string {
  const parts: string[] = [];
  let base = "0:v";
  if (textFile) {
    const { start: b0, end: b1 } = ch.bubble;
    parts.push(
      `[2:v]format=rgba,fade=t=in:st=${b0}:d=0.2:alpha=1,fade=t=out:st=${(b1 - 0.2).toFixed(2)}:d=0.2:alpha=1[bub]`,
      `[0:v][bub]overlay=x=${L.bubbleX}:y=${L.bubbleY}:enable='between(t,${b0},${b1})'[vb]`,
      `[vb]drawtext=fontfile=${fontFile}:textfile=${textFile}:fontcolor=0x1B2A47:fontsize=${L.fontSize}:` +
        `x=${L.bubbleX}+(${L.bubbleW}-text_w)/2:y=${L.bubbleY}+(${Math.round(L.bubbleH * 0.68)}-text_h)/2:` +
        `enable='between(t,${(b0 + 0.12).toFixed(2)},${(b1 - 0.12).toFixed(2)})'[vt]`,
    );
    base = "vt";
  }
  parts.push(`[${base}][1:v]overlay=x=${L.spriteX}:y=${L.spriteY}:eof_action=pass,format=yuv420p[vout]`);
  return parts.join(";\n");
}

/** ffmpeg's drawtext needs a relative forward-slash path on Windows (an absolute one breaks on the drive colon). */
const relForFilter = (p: string) => path.relative(process.cwd(), p).split(path.sep).join("/");

/**
 * Overlay Ameublo on `input`, writing `output`. Throws on ffmpeg failure (the caller decides
 * whether a clip without the mascot is acceptable).
 */
export async function applyAmeubloOverlay(input: string, output: string, opts: AmeubloOverlayOptions): Promise<void> {
  const sharp = (await import("sharp")).default;
  const fps = opts.fps ?? 30;
  const clip = probeClip(opts.ffmpegBin, input);
  const ch = defaultChoreography(clip.duration, opts.accessory ?? "none", opts.corner === "left" ? "right" : "left");
  const L = overlayLayout(clip.width, clip.height, opts, opts.bubbleText ?? "");

  // Frames and the text file live under cwd so drawtext can take a relative path.
  const work = fs.mkdtempSync(path.join(process.cwd(), ".ameublo-"));
  try {
    const n = Math.ceil(clip.duration * fps);
    for (let i = 0; i < n; i++) {
      // No floor shadow when he floats in the top corner.
      const svg = ameubloSvg(ameubloPoseAt(i / fps, ch), L.sprite, { shadow: opts.vertical !== "top" });
      await sharp(Buffer.from(svg)).png().toFile(path.join(work, `${String(i).padStart(5, "0")}.png`));
    }
    let textFile: string | null = null;
    const bubblePng = path.join(work, "bubble.png");
    if (opts.bubbleText) {
      await sharp(Buffer.from(bubbleSvg(L.bubbleW, L.bubbleH, opts.corner ?? "right"))).png().toFile(bubblePng);
      textFile = relForFilter(path.join(work, "bubble.txt"));
      fs.writeFileSync(path.join(work, "bubble.txt"), opts.bubbleText, "utf8");
    }
    const graphFile = path.join(work, "graph.txt");
    fs.writeFileSync(graphFile, buildOverlayGraph(L, ch, textFile, relForFilter(opts.fontFile)), "utf8");

    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-framerate", String(fps), "-i", path.join(work, "%05d.png"),
      ...(opts.bubbleText ? ["-loop", "1", "-framerate", String(fps), "-t", String(clip.duration), "-i", bubblePng] : []),
      "-filter_complex_script", graphFile,
      "-map", "[vout]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart",
      output,
    ];
    const res = spawnSync(opts.ffmpegBin, args, { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`ameublo overlay failed: ${(res.stderr || "").slice(-400)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

