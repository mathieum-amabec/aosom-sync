/**
 * Clean-window selection + post-render verification for the demand-gen-ext batch pipeline.
 *
 * WHY THIS EXISTS, NOT `analyzeClip` DIRECTLY
 * `analyzeClip` (video-scene-selector.ts) was built for sequential-ad footage: pick a 15-20s
 * window, using a rubric tuned for "dynamic UGC, no overlay". Reused as-is for demand-gen-ext,
 * it under-corrected in 3 distinct, generalizable ways (found by frame-by-frame review of the
 * raw source videos after the first fix round still shipped defects):
 *
 *   1. SAMPLING TOO SPARSE. `FRAME_COUNT=12` spread across a 20-40s clip samples roughly every
 *      3s. A brand bumper/logo that flashes on/off in ~1s bursts (confirmed on 837-164WT via a
 *      1fps full-clip contact sheet: HOMCOM's little house icon appears intermittently through
 *      almost the ENTIRE clip, not just an opening card) can simply fall in the gaps between
 *      samples. Fix: sample near 1 frame/second (`frameCount = min(40, ceil(duration))`) —
 *      more Vision calls per SKU, accepted cost for reliability.
 *
 *   2. WRONG RUBRIC. `FRAME_PROMPT` scores "product visible, dynamic, no text" — it does NOT
 *      penalize a shot that is too TIGHT to show the whole product, because for a sequential ad
 *      a tight dynamic detail shot is often desirable. For demand-gen the opposite is true (the
 *      831-425/HOMCOM case aside, 830-243's failure was pure framing: Vision's own top window
 *      [8.5s-28.5s] was a hands-decorating close-up that never shows the full tree — scored
 *      well under the OLD rubric because it *is* well-lit and text-free). Fix: a dedicated,
 *      stricter prompt (`STRICT_DEMAND_GEN_PROMPT`) that scores full-product-visibility AND
 *      text/logo-freedom as two independent gates, either of which caps the score at 2.
 *
 *   3. WINDOW LENGTH MISMATCH. `analyzeClip`'s window is 15-20s; our render is 6s. For a clip
 *      shorter than ~20s, `bestWindow`'s target collapses to the whole clip (`min(maxSeg,
 *      duration)`), forcing `startTime=0` even when the first ~2s are bad and the rest is fine
 *      (831-425: a 2s English caption card at t=0-2, then 16s of clean footage — the WHOLE-CLIP
 *      average still scored high, hiding the bad opening). Fix: never trust `startTime`/
 *      `endTime` from the big window — re-run `bestWindow` ourselves on the same scored frames
 *      at the ACTUAL render duration (6s), which finds the genuinely best 6s sub-window instead
 *      of "the first 6s of a mostly-good 15-20s region".
 *
 * POST-RENDER VERIFICATION (Étape 5 of this correction round): a clean source window is
 * necessary but not sufficient — the render itself (crop, blur-pad, overlay) could still leave
 * something visible. `verifyRenderedClip` re-scores 3 frames of the FINAL output with the same
 * strict prompt; the caller must not queue a clip that fails this.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAnthropicClient } from "@/lib/content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { bestWindow, type FrameScore } from "@/lib/video-scene-selector";

const execFileAsync = promisify(execFile);

export const STRICT_DEMAND_GEN_PROMPT =
  "Tu évalues une frame vidéo pour une pub produit e-commerce. Réponds UNIQUEMENT en JSON: " +
  '{"full_product_visible": <true|false>, "has_text_or_logo": <true|false>, "reason": "<une phrase courte>"}\n\n' +
  "full_product_visible = true SEULEMENT si le produit complet est visible dans le cadre (pas juste un détail zoomé, pas coupé). " +
  "has_text_or_logo = true si N'IMPORTE QUEL texte ou logo est visible : logo de marque (même petit, même dans un coin, même partiellement transparent), " +
  "légende/texte marketing incrusté, lignes ou chiffres de dimension/mesure, badges, icônes promotionnelles. " +
  "Un texte diégétique (étiquette sur le produit lui-même) ne compte PAS. En cas de doute, réponds true (sois strict).";

export interface StrictFrameVerdict {
  fullProductVisible: boolean;
  hasTextOrLogo: boolean;
  reason: string;
}

/**
 * Separate from STRICT_DEMAND_GEN_PROMPT on purpose — reusing that prompt verbatim on the
 * FINAL rendered clip was itself a bug (found by running this exact mechanism for the first
 * time, real output not code review): every rendered clip carries our OWN intentional overlay
 * (title band top, gold "Livraison gratuite au Canada" pill bottom, Ameublo Direct logo) by
 * design, and the source-scoring prompt has no way to know that's expected — it failed all 7/7
 * renders on THAT overlay, not on any actual defect. This prompt explicitly tells Vision to
 * ignore our own template elements and only flag what doesn't belong there.
 */
export const STRICT_RENDERED_CLIP_PROMPT =
  "Tu évalues une frame d'une pub produit e-commerce déjà montée (PAS la vidéo brute). " +
  "Cette pub a un habillage INTENTIONNEL et ATTENDU que tu dois IGNORER complètement, ce n'est " +
  "JAMAIS un défaut : un bandeau de titre en haut (fond navy), une pastille dorée " +
  '"Livraison gratuite au Canada" en bas, et un logo/filigrane "Ameublo Direct" ou "ameublodirect.ca". ' +
  "Réponds UNIQUEMENT en JSON: " +
  '{"full_product_visible": <true|false>, "has_text_or_logo": <true|false>, "reason": "<une phrase courte>"}\n\n' +
  "full_product_visible = true si le produit est raisonnablement visible dans son ensemble DANS LA ZONE CENTRALE " +
  "de l'image (ignore le fait que le bandeau du haut ou la pastille du bas puisse chevaucher le produit — " +
  "c'est normal et voulu). false SEULEMENT si le produit est vraiment tronqué par le cadrage de la VIDÉO elle-même " +
  "(caméra trop zoomée), pas par notre propre habillage.\n" +
  "has_text_or_logo = true UNIQUEMENT si tu vois un texte ou logo qui N'EST PAS notre habillage attendu : " +
  "un logo fournisseur (HOMCOM, Aosom, Outsunny, PawHut, Qaba, Vinsetto), du texte anglais, un diagramme de " +
  "montage, des lignes de dimension/mesure, ou tout autre texte incrusté qui n'est ni notre bandeau de titre " +
  "ni notre pastille de livraison ni notre logo Ameublo Direct. Le titre du produit lui-même (en français, dans " +
  "le bandeau navy du haut) NE COMPTE PAS comme défaut.";

function resolveFfprobe(ffmpegBin: string): string {
  if (process.env.FFPROBE_BIN) return process.env.FFPROBE_BIN;
  const guess = path.join(path.dirname(ffmpegBin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  return fs.existsSync(guess) ? guess : "ffprobe";
}

async function probeDuration(src: string, ffprobeBin: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src,
  ]);
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe returned no duration for ${src}`);
  return d;
}

async function extractFrame(src: string, t: number, outFile: string, ffmpegBin: string): Promise<void> {
  await execFileAsync(ffmpegBin, [
    "-y", "-nostdin", "-loglevel", "error",
    "-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-q:v", "3", outFile,
  ]);
}

async function scoreFrameWithPrompt(
  jpegPath: string,
  prompt: string,
): Promise<{ score: number; reason: string; verdict: StrictFrameVerdict } | null> {
  const buf = await fs.promises.readFile(jpegPath);
  const message = await budgetedCreate(getAnthropicClient(), {
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const text = message.content.map((c) => ("text" in c ? c.text : "")).join("");
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let parsed: { full_product_visible?: unknown; has_text_or_logo?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const fullProductVisible = parsed.full_product_visible === true;
  const hasTextOrLogo = parsed.has_text_or_logo !== false; // default to strict (true) on ambiguity
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";
  const score = !fullProductVisible || hasTextOrLogo ? 2 : 9;
  return { score, reason, verdict: { fullProductVisible, hasTextOrLogo, reason } };
}

/** Strict scorer for RAW SOURCE frames: caps the score at 2 if EITHER gate fails, else 9. */
export async function scoreFrameStrict(jpegPath: string): Promise<{ score: number; reason: string; verdict: StrictFrameVerdict } | null> {
  return scoreFrameWithPrompt(jpegPath, STRICT_DEMAND_GEN_PROMPT);
}

/** Same gates, but for the FINAL rendered/branded clip — ignores our own intentional overlay. */
export async function scoreFrameRendered(jpegPath: string): Promise<{ score: number; reason: string; verdict: StrictFrameVerdict } | null> {
  return scoreFrameWithPrompt(jpegPath, STRICT_RENDERED_CLIP_PROMPT);
}

export interface CleanWindowResult {
  startTime: number;
  endTime: number;
  frames: FrameScore[];
  /** false when every sampled frame in the chosen window still failed a gate — do not render. */
  ok: boolean;
  reason: string;
}

/**
 * Find the best `targetSec`-length window using DENSE sampling (~1/sec) and the strict
 * dual-gate prompt, re-windowed at the actual render duration rather than analyzeClip's
 * 15-20s default (see module header, point 3).
 */
export async function findCleanWindow(
  srcPath: string,
  targetSec: number,
  opts: { ffmpegBin?: string; maxFrames?: number } = {},
): Promise<CleanWindowResult> {
  const ffmpegBin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const ffprobeBin = resolveFfprobe(ffmpegBin);
  const duration = await probeDuration(srcPath, ffprobeBin);
  const frameCount = Math.min(opts.maxFrames ?? 40, Math.max(6, Math.ceil(duration)));

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dgclean-"));
  const frames: FrameScore[] = [];
  try {
    for (let i = 0; i < frameCount; i++) {
      const t = (duration * (i + 0.5)) / frameCount;
      const jpeg = path.join(workDir, `f${i}.jpg`);
      try {
        await extractFrame(srcPath, t, jpeg, ffmpegBin);
        const s = await scoreFrameStrict(jpeg);
        if (s) frames.push({ t: Number(t.toFixed(3)), score: s.score, reason: s.reason, zone: "middle" });
      } catch {
        // one bad frame must not sink the whole scan
      }
    }
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }

  const win = bestWindow(frames, duration, targetSec, targetSec);
  const insideGood = frames.filter((f) => f.t >= win.startTime && f.t <= win.endTime && f.score >= 9);
  const ok = frames.length > 0 && win.avgScore >= 7; // strict scorer only emits 2 or 9 — 7 means "mostly clean"
  return {
    startTime: win.startTime,
    endTime: win.endTime,
    frames,
    ok,
    reason: ok
      ? (insideGood[0]?.reason ?? "fenêtre propre")
      : `aucune fenêtre de ${targetSec}s suffisamment propre trouvée (meilleure moyenne: ${win.avgScore.toFixed(1)}/9)`,
  };
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
  sampled: { t: number; verdict: StrictFrameVerdict }[];
}

/**
 * Re-check the FINAL rendered clip (post-crop/blur-pad/overlay) — a clean source window does
 * not guarantee the render itself stayed clean. Samples `count` frames across the output and
 * fails if ANY sampled frame still trips a gate.
 */
export async function verifyRenderedClip(
  outPath: string,
  opts: { ffmpegBin?: string; count?: number } = {},
): Promise<VerifyResult> {
  const ffmpegBin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const ffprobeBin = resolveFfprobe(ffmpegBin);
  const duration = await probeDuration(outPath, ffprobeBin);
  const count = opts.count ?? 3;

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dgverify-"));
  const sampled: { t: number; verdict: StrictFrameVerdict }[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count;
      const jpeg = path.join(workDir, `v${i}.jpg`);
      await extractFrame(outPath, t, jpeg, ffmpegBin);
      const s = await scoreFrameRendered(jpeg);
      if (s) sampled.push({ t: Number(t.toFixed(3)), verdict: s.verdict });
    }
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }

  const failing = sampled.filter((s) => !s.verdict.fullProductVisible || s.verdict.hasTextOrLogo);
  return {
    ok: sampled.length > 0 && failing.length === 0,
    reason: failing.length > 0 ? failing[0].verdict.reason : "clip final vérifié propre",
    sampled,
  };
}
