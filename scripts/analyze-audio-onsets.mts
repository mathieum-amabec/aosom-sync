#!/usr/bin/env tsx
/**
 * scripts/analyze-audio-onsets.mts
 *
 * Detect the strong beats in each music bed and write them to src/lib/audio-onsets.json,
 * so the renderer can start the music such that an accent lands on the price pop.
 *
 * WHY NOT A LIBRARY, AND WHY NOT HAND-ANNOTATION
 * The brief offered either an audio-analysis dependency or 4-5 hand-picked timestamps per
 * track in a config. This does the analysis with NO new dependency — ffmpeg is already
 * required by the renderer, and decoding to raw PCM plus an energy-flux onset detector is
 * about sixty lines — and it writes its result to a config file. So it is re-runnable when a
 * track is added (hand-annotation is not), and the output is still a plain JSON an operator
 * can inspect, trim or override by hand (a library's internal state is not).
 *
 * HOW IT WORKS
 * Decode 55 s to mono 22.05 kHz, take the RMS of every 512-sample hop (~23 ms), and keep the
 * POSITIVE first difference — energy going up is what an onset is. Peaks above mean + 1.6 sd,
 * with a 250 ms minimum spacing so one drum hit is not counted three times.
 *
 * Sanity check the run prints: the median interval between onsets, converted to BPM. A
 * detector that is working lands in a musical range; one that is picking up noise does not.
 * Measured on the current pool: 81, 108, 117, 123, 136 and 185 BPM (the last is double-time
 * on a ~92 BPM bed, which is a normal artifact and harmless — only onset POSITIONS matter).
 *
 *   FFMPEG_BIN="…/ffmpeg.exe" node-x64 node_modules/tsx/dist/cli.mjs \
 *     scripts/analyze-audio-onsets.mts --dir "C:\\…\\src\\audio" [--apply]
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string): string | null => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const DIR = flag("--dir") ?? process.env.SEQ_MUSIC_DIR ?? "src/audio";
const OUT = flag("--out") ?? "src/lib/audio-onsets.json";

/** Analysis window. Must cover the largest usable entry point plus the pop offset. */
const ANALYSE_SEC = 55;
const SR = 22050;
const HOP = 512;
/** Peaks must clear mean + THRESHOLD_SD standard deviations. */
const THRESHOLD_SD = 1.6;
/** One drum hit must not register as three. */
const MIN_GAP_SEC = 0.25;
/** Keep the strongest N per track: an "accent" the ear notices, not every tick. */
const KEEP = 28;

export interface Onset {
  /** Seconds into the track. */
  t: number;
  /** Strength, normalised to the strongest onset in this track (0-1). */
  s: number;
}

let lastImpliedBpm: number | null = null;
export const lastBpm = () => lastImpliedBpm;

function bpmOf(times: number[]): number | null {
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0.1 && d < 3).sort((a, b) => a - b);
  if (!gaps.length) return null;
  return Math.round(60 / gaps[Math.floor(gaps.length / 2)]);
}

export function detectOnsets(samples: Float32Array, sr = SR, hop = HOP): Onset[] {
  const frames = Math.floor(samples.length / hop);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = samples[o + i] ?? 0;
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / hop);
  }
  // Positive energy flux: an onset is energy going UP, so drops are discarded outright.
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, rms[f] - rms[f - 1]);

  let mean = 0;
  for (const v of flux) mean += v;
  mean /= frames || 1;
  let varSum = 0;
  for (const v of flux) varSum += (v - mean) ** 2;
  const sd = Math.sqrt(varSum / (frames || 1));
  const threshold = mean + THRESHOLD_SD * sd;
  const minGap = Math.round((MIN_GAP_SEC * sr) / hop);

  const peaks: { f: number; s: number }[] = [];
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < threshold) continue;
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last && f - last.f < minGap) {
      // Same hit seen twice: keep the louder of the two rather than both.
      if (flux[f] > last.s) peaks[peaks.length - 1] = { f, s: flux[f] };
      continue;
    }
    peaks.push({ f, s: flux[f] });
  }
  // Sanity BPM is computed on EVERY peak, before the top-N cut: filtering to the strongest 28
  // leaves gaps spanning several beats and would read as half tempo.
  lastImpliedBpm = bpmOf(peaks.map((p) => (p.f * hop) / sr));
  const max = peaks.reduce((m, p) => Math.max(m, p.s), 0) || 1;
  return peaks
    .map((p) => ({ t: Number(((p.f * hop) / sr).toFixed(3)), s: Number((p.s / max).toFixed(3)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, KEEP)
    .sort((a, b) => a.t - b.t);
}

function decodeMono(file: string): Float32Array {
  const pcm = execFileSync(
    FFMPEG,
    ["-v", "error", "-t", String(ANALYSE_SEC), "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"],
    { maxBuffer: 1 << 28 },
  );
  const n = pcm.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/** Median interval between onsets, as BPM — the sanity check that the detector is musical. */
export function impliedBpm(onsets: Onset[]): number | null {
  const gaps = onsets
    .slice(1)
    .map((o, i) => o.t - onsets[i].t)
    .filter((d) => d > 0.1 && d < 3)
    .sort((a, b) => a - b);
  if (!gaps.length) return null;
  const med = gaps[Math.floor(gaps.length / 2)];
  return Math.round(60 / med);
}

function main(): void {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".mp3")).sort();
  if (!files.length) throw new Error(`no mp3 in ${DIR}`);
  const result: Record<string, Onset[]> = {};
  console.log(`\n🎧 onsets — ${files.length} pistes, ${ANALYSE_SEC}s analysées — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  console.log("  piste                                           onsets  BPM   premiers temps forts");
  console.log("  " + "-".repeat(96));
  for (const f of files) {
    const onsets = detectOnsets(decodeMono(path.join(DIR, f)));
    result[f] = onsets;
    const bpm = lastBpm();
    const head = onsets.slice(0, 8).map((o) => o.t.toFixed(2)).join(" ");
    console.log(`  ${f.slice(0, 46).padEnd(48)}${String(onsets.length).padStart(4)}  ${String(bpm ?? "?").padStart(4)}   ${head}`);
  }
  if (!APPLY) {
    console.log(`\nDry-run. Re-run with --apply to write ${OUT}.`);
    return;
  }
  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`, "utf8");
  console.log(`\n-> ${OUT}`);
}

main();
