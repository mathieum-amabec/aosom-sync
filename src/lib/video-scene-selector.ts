/**
 * Pick the best 15-20 s segment of a product clip, using Claude Vision to score frames.
 *
 * WHY THIS EXISTS
 * The sequential-ad renderer used to hard-code `-ss 3` and take whatever the next 15 seconds
 * happened to be. On a real customer reel that is a coin flip: UGC clips open on a hand
 * reaching for the box, cut to a spec card halfway through, and only show the assembled
 * product for a few seconds somewhere in the middle. This module finds those seconds instead
 * of guessing.
 *
 * COST SHAPE
 * 12 frames per clip, one Vision call each, on the `batch` budget pool. That is 12 calls to
 * choose a window — deliberately cheap relative to the render, and it happens once per clip
 * per campaign, not per view. `analyzeClip` never throws for a scoring failure: an
 * unscoreable frame is dropped, and if every frame fails the caller still gets a usable
 * window (see `FALLBACK_REASON`), because a mediocre segment ships and a crash does not.
 *
 * TEST SEAMS
 * `extractFrame`, `probeDuration` and `scoreFrame` are all injectable. The suite exercises
 * the windowing maths — which is the part with real edge cases — without ffmpeg or an API key.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAnthropicClient } from "@/lib/content-generator";
import { budgetedCreate } from "@/lib/llm-budget";

const execFileAsync = promisify(execFile);

/** The exact rubric the operator specified. Kept verbatim: it is the scoring contract. */
export const FRAME_PROMPT =
  "Score this frame 1-10 for a furniture/product ad: 10=product clearly visible, good lighting, " +
  "dynamic scene, no text overlay. 1=blurry, dark, product not visible, text overlay present. " +
  'Return JSON: {score: N, reason: \'brief\'}';

/** How many frames to sample across the clip. */
export const FRAME_COUNT = 12;
/** Segment length bounds, in seconds. */
export const MIN_SEGMENT = 15;
export const MAX_SEGMENT = 20;

/** Vision's verdict on one sampled frame. */
export interface FrameScore {
  /** Seconds into the clip. */
  t: number;
  /** 1-10. */
  score: number;
  reason: string;
}

export interface ClipAnalysis {
  startTime: number;
  endTime: number;
  avgScore: number;
  reason: string;
  /** Every frame that scored, for logging. Empty when scoring was skipped entirely. */
  frames: FrameScore[];
}

export interface AnalyzeOptions {
  /** Path to ffmpeg. Defaults to $FFMPEG_BIN, then "ffmpeg" on PATH. */
  ffmpegBin?: string;
  /** Path to ffprobe. Defaults to $FFPROBE_BIN, then ffprobe beside ffmpeg. */
  ffprobeBin?: string;
  frameCount?: number;
  /** Seam: clip length in seconds. */
  probeDuration?: (src: string) => Promise<number>;
  /** Seam: write a JPEG of the frame at `t` and return its path. */
  extractFrame?: (src: string, t: number, outFile: string) => Promise<void>;
  /** Seam: score one JPEG. Return null to drop the frame. */
  scoreFrame?: (jpegPath: string) => Promise<{ score: number; reason: string } | null>;
}

/** Said when no frame could be scored, so the caller can tell a real pick from a fallback. */
export const FALLBACK_REASON = "aucune frame notée — segment par défaut";

// ── ffmpeg/ffprobe defaults ───────────────────────────────────────────────

function resolveFfprobe(ffmpegBin: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.FFPROBE_BIN) return process.env.FFPROBE_BIN;
  // ffprobe ships beside ffmpeg in every build we use; fall back to PATH if it does not.
  const guess = path.join(path.dirname(ffmpegBin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  return fs.existsSync(guess) ? guess : "ffprobe";
}

async function defaultProbeDuration(src: string, ffprobeBin: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src,
  ]);
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe returned no duration for ${src}`);
  return d;
}

async function defaultExtractFrame(src: string, t: number, outFile: string, ffmpegBin: string): Promise<void> {
  // -ss BEFORE -i seeks on keyframes, which is fast and accurate enough for scoring.
  await execFileAsync(ffmpegBin, [
    "-y", "-nostdin", "-loglevel", "error",
    "-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-q:v", "3", outFile,
  ]);
}

// ── Vision scoring ────────────────────────────────────────────────────────

/** Pull the first JSON object out of a model reply that may carry prose around it. */
export function parseScoreReply(text: string): { score: number; reason: string } | null {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    // The prompt asks for {score: N, reason: 'brief'} — single quotes and bare keys are
    // valid JS but not JSON, and the model does emit them. Repair rather than discard.
    try {
      obj = JSON.parse(
        m[0]
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
          .replace(/'/g, '"'),
      );
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const raw = (obj as Record<string, unknown>).score;
  const score = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(score)) return null;
  const reason = String((obj as Record<string, unknown>).reason ?? "").slice(0, 200);
  // Clamp rather than reject: a model that answers 0 or 11 still ranked the frame.
  return { score: Math.min(10, Math.max(1, score)), reason };
}

async function defaultScoreFrame(jpegPath: string): Promise<{ score: number; reason: string } | null> {
  const buf = await fs.promises.readFile(jpegPath);
  const res = await budgetedCreate(getAnthropicClient(), {
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
          { type: "text", text: FRAME_PROMPT },
        ],
      },
    ],
  });
  const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
  return parseScoreReply(text);
}

// ── windowing ─────────────────────────────────────────────────────────────

/**
 * Best contiguous window, given scored sample points.
 *
 * Slides a candidate start over a fine grid instead of walking frame indices. Frames are
 * evenly spaced, so index arithmetic looks equivalent — but it breaks the moment a frame is
 * dropped for failing to score, which is exactly when the clip is patchy and the choice
 * matters most. Averaging whatever frames land inside the window degrades gracefully.
 *
 * Prefers MAX_SEGMENT when the clip allows it: a longer window at the same average score
 * carries more of the product. A clip shorter than MIN_SEGMENT returns itself whole.
 */
export function bestWindow(
  frames: FrameScore[],
  duration: number,
  minSeg = MIN_SEGMENT,
  maxSeg = MAX_SEGMENT,
): { startTime: number; endTime: number; avgScore: number; reason: string } {
  if (duration <= minSeg) {
    const avg = frames.length ? frames.reduce((s, f) => s + f.score, 0) / frames.length : 0;
    return {
      startTime: 0,
      endTime: Number(duration.toFixed(3)),
      avgScore: Number(avg.toFixed(2)),
      reason: frames.length ? "clip plus court que la fenêtre minimale — pris en entier" : FALLBACK_REASON,
    };
  }
  const target = Math.min(maxSeg, duration);
  if (frames.length === 0) {
    return { startTime: 0, endTime: Number(target.toFixed(3)), avgScore: 0, reason: FALLBACK_REASON };
  }
  const latest = duration - target;
  const STEP = 0.25;
  let best = { start: 0, avg: -1, inside: [] as FrameScore[] };
  for (let s = 0; s <= latest + 1e-9; s += STEP) {
    const inside = frames.filter((f) => f.t >= s && f.t <= s + target);
    if (inside.length === 0) continue;
    const avg = inside.reduce((a, f) => a + f.score, 0) / inside.length;
    // Strictly greater keeps the EARLIEST of equally-good windows, which is what an ad wants:
    // the sooner the good footage starts, the sooner the viewer sees the product.
    if (avg > best.avg) best = { start: s, avg, inside };
  }
  if (best.avg < 0) {
    return { startTime: 0, endTime: Number(target.toFixed(3)), avgScore: 0, reason: FALLBACK_REASON };
  }
  const top = best.inside.slice().sort((a, b) => b.score - a.score)[0];
  return {
    startTime: Number(best.start.toFixed(3)),
    endTime: Number((best.start + target).toFixed(3)),
    avgScore: Number(best.avg.toFixed(2)),
    reason: top?.reason || "meilleur segment moyen",
  };
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Score `frameCount` frames across the clip and return the best 15-20 s window.
 *
 * `skuPath` is the clip file itself. Never throws for a scoring failure — only for a missing
 * file or an unreadable duration, both of which mean there is nothing to render at all.
 */
export async function analyzeClip(skuPath: string, opts: AnalyzeOptions = {}): Promise<ClipAnalysis> {
  if (!fs.existsSync(skuPath)) throw new Error(`clip missing: ${skuPath}`);
  const ffmpegBin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const ffprobeBin = resolveFfprobe(ffmpegBin, opts.ffprobeBin);
  const n = opts.frameCount ?? FRAME_COUNT;

  const probe = opts.probeDuration ?? ((s: string) => defaultProbeDuration(s, ffprobeBin));
  const extract = opts.extractFrame ?? ((s: string, t: number, o: string) => defaultExtractFrame(s, t, o, ffmpegBin));
  const score = opts.scoreFrame ?? defaultScoreFrame;

  const duration = await probe(skuPath);
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "scene-"));
  const frames: FrameScore[] = [];
  try {
    for (let i = 0; i < n; i++) {
      // Sample at interval midpoints: the very first and last frames of a clip are often a
      // fade or a black frame, and would drag their window down for no real reason.
      const t = (duration * (i + 0.5)) / n;
      const jpeg = path.join(workDir, `f${i}.jpg`);
      try {
        await extract(skuPath, t, jpeg);
        const s = await score(jpeg);
        if (s) frames.push({ t: Number(t.toFixed(3)), score: s.score, reason: s.reason });
      } catch {
        // One unreadable or unscoreable frame must not sink the clip.
      }
    }
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
  return { ...bestWindow(frames, duration), frames };
}
