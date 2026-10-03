/**
 * Ameublo video STYLES — full-frame scenes starring the mascot, all free (sharp + ffmpeg,
 * no AI call). Each style is a pure "what is on screen at time t" function; `renderScene`
 * rasterises it frame by frame and pipes raw RGBA to ffmpeg.
 *
 *   reaction — a customer clip in a card, Ameublo reacting under it (wow → laugh → points).
 *   vitrine  — product photos on a card, Ameublo presenting them, price tag drops in.
 *   astuce   — "L'astuce d'Ameublo": he thinks, shares a practical tip, then suggests a product.
 *
 * Review only for now (Studio Ameublo, scripts/ameublo-style-samples.mts).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OverlayOptions } from "sharp";
import { ameubloSvg, NEUTRAL_POSE, type AmeubloPose, type AmeubloAccessory } from "@/lib/ameublo-sprite";
import type { AmeubloLines } from "@/lib/ameublo-copy";

export const W = 1080;
export const H = 1920;
export const FPS = 30;

const NAVY = "#1B2A47";
const GOLD = "#D4A853";
const CREAM = "#FBF3E2";

// ── small maths ────────────────────────────────────────────────────────────

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** 0→1 progress of `t` through [a, a+d]. */
export const prog = (t: number, a: number, d: number) => clamp01((t - a) / d);
export const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
export const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** CAD the Quebec way (84,99 $). */
export function priceFr(n: number): string {
  return new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" })
    .format(n)
    .replace(/ | /g, " ");
}

/** Greedy word wrap at `max` characters per line, capped at `maxLines` (last line gets "…"). */
export function wrap(text: string, max: number, maxLines = 3): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

// ── layers ─────────────────────────────────────────────────────────────────

interface TextOpts {
  size: number;
  color?: string;
  weight?: 400 | 700;
  /** Centre x; defaults to the frame centre. */
  cx?: number;
  lineGap?: number;
  opacity?: number;
  stroke?: string;
}

// Text goes through sharp's Pango renderer with the bundled TTF (`fontfile`): librsvg's SVG
// <text> resolves fonts through fontconfig, which ignores our DM Sans on Windows and falls
// back to a serif. Rendered lines are cached — most of them repeat on every frame.
type TextImg = { buf: Buffer; w: number; h: number };
const textCache = new Map<string, Promise<TextImg>>();
// An invisible "ÉÇ" after every line gives all lines the same box (accent above, cedilla
// below), so a line with "Î" is not pushed down relative to one without.
const STRUT = "ÉÇ";
const strutCache = new Map<string, Promise<number>>();

function textImg(s: string, size: number, color: string, weight: 400 | 700 = 700, opacity = 1): Promise<TextImg> {
  const op = Math.round(clamp01(opacity) * 50) / 50;
  const key = [s, size, color, weight, op].join("|");
  let hit = textCache.get(key);
  if (!hit) {
    hit = (async () => {
      const sharp = (await import("sharp")).default;
      const fontfile = path.join(process.cwd(), "src", "fonts", weight === 700 ? "DMSans-Bold.ttf" : "DMSans-Regular.ttf");
      const font = `DM Sans ${weight === 700 ? "Bold " : ""}${size}`;
      const sk = `${weight}|${size}`;
      if (!strutCache.has(sk)) {
        strutCache.set(sk, sharp({ text: { text: STRUT, font, fontfile, rgba: true, dpi: 72 } }).png().toBuffer()
          .then((b) => sharp(b).metadata()).then((m) => m.width ?? 0));
      }
      const strutW = await strutCache.get(sk)!;
      let img = sharp({
        text: { text: `<span foreground="${color}">${esc(s)}</span><span foreground="#000000" alpha="1">${STRUT}</span>`, font, fontfile, rgba: true, dpi: 72 },
      });
      if (op < 1) img = sharp(await img.png().toBuffer()).ensureAlpha().linear([1, 1, 1, op], [0, 0, 0, 0]);
      const buf = await img.png().toBuffer();
      const m = await sharp(buf).metadata();
      // w = the VISIBLE width (the strut trails on the right), so centring stays exact.
      return { buf, w: Math.max(0, (m.width ?? 0) - strutW), h: m.height ?? 0 };
    })();
    textCache.set(key, hit);
  }
  return hit;
}

/** Centred multi-line text; the first line's top edge sits at `top`. */
export async function textLayer(lines: string[], top: number, o: TextOpts): Promise<OverlayOptions[]> {
  if ((o.opacity ?? 1) <= 0) return [];
  const gap = o.lineGap ?? Math.round(o.size * 1.18);
  const cx = o.cx ?? W / 2;
  const out: OverlayOptions[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = await textImg(lines[i], o.size, o.color ?? NAVY, o.weight ?? 700, o.opacity ?? 1);
    out.push({ input: t.buf, left: Math.max(0, Math.round(cx - t.w / 2)), top: Math.round(top + i * gap) });
  }
  return out;
}

/** Ameublo at (x, y), `size` px square. */
export function ameubloLayer(pose: AmeubloPose, size: number, x: number, y: number, shadow = true): OverlayOptions {
  return { input: Buffer.from(ameubloSvg(pose, Math.round(size), { shadow })), left: Math.round(x), top: Math.round(y) };
}

/** White speech bubble with centred text at (x, y), `w` wide, tail pointing down at `tailX`. */
export async function bubbleLayer(lines: string[], x: number, y: number, w: number, size: number, tailX: number, opacity = 1): Promise<OverlayOptions[]> {
  if (opacity <= 0) return [];
  const gap = Math.round(size * 1.15);
  const bodyH = Math.round(gap * lines.length + size * 0.9);
  const h = bodyH + 34;
  const tx = Math.round(tailX - x);
  const tail = `M${tx - 22} ${bodyH - 8} L${tx} ${h - 2} L${tx + 18} ${bodyH - 8} Z`;
  const shape: OverlayOptions = {
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g opacity="${opacity}">` +
        `<path d="${tail}" fill="#fff" stroke="${NAVY}" stroke-width="5" stroke-linejoin="round"/>` +
        `<rect x="3" y="3" width="${w - 6}" height="${bodyH - 6}" rx="${Math.round(Math.min(48, bodyH / 2.4))}" fill="#fff" stroke="${NAVY}" stroke-width="5"/>` +
        `<path d="${tail}" fill="#fff" transform="translate(0 -4)"/></g></svg>`,
    ),
    left: Math.round(x),
    top: Math.round(y),
  };
  const text = await textLayer(lines, y + Math.round(size * 0.38), { size, color: NAVY, cx: x + w / 2, lineGap: gap, opacity });
  return [shape, ...text];
}

/** Gold price pill (+ optional small line under it), centred on cx. */
export async function priceTagLayer(price: string, cx: number, top: number, sub?: string, scale = 1, subColor = NAVY): Promise<OverlayOptions[]> {
  const size = Math.round(84 * scale);
  const priceImg = await textImg(price, size, NAVY);
  const w = Math.round(priceImg.w + size * 1.1);
  const pillH = Math.round(size * 1.4);
  const out: OverlayOptions[] = [
    {
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${pillH}"><rect width="${w}" height="${pillH}" rx="${pillH / 2}" fill="${GOLD}"/></svg>`),
      left: Math.round(cx - w / 2),
      top: Math.round(top),
    },
    { input: priceImg.buf, left: Math.round(cx - priceImg.w / 2), top: Math.round(top + (pillH - priceImg.h) / 2) },
  ];
  if (sub) out.push(...(await textLayer([sub], top + pillH + Math.round(size * 0.12), { size: Math.round(size * 0.38), color: subColor, cx })));
  return out;
}

/** Solid or two-stop vertical gradient background, as PNG. */
async function backgroundPng(from: string, to = from): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="url(#g)"/></svg>`,
  )).png().toBuffer();
}

/** A photo cropped to w×h with rounded corners, as PNG. */
export async function photoCard(src: Buffer, w: number, h: number, radius = 36): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  // "contain" on white: the whole product stays visible, whatever the photo's framing.
  const img = await sharp(src).resize(w, h, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).png().toBuffer();
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" fill="#fff"/></svg>`);
  return sharp(img).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

// ── renderer ───────────────────────────────────────────────────────────────

export interface SceneSpec {
  duration: number;
  /** Opaque full-frame PNG under everything. */
  background: Buffer;
  /** Optional video clip drawn into a box between the background and the layers. */
  clip?: { file: string; x: number; y: number; w: number; h: number; start?: number };
  /** Everything else, for time t. Layers are composited in order. */
  layersAt: (t: number) => Promise<OverlayOptions[]> | OverlayOptions[];
  /** Music bed; omitted → silent track. `keepClipAudio` mixes the clip's own sound instead. */
  music?: string;
  musicVolume?: number;
}

/**
 * Render a scene to an MP4 (1080×1920, 30 fps, H.264 + AAC).
 *
 * The animated layers are composited by sharp into a transparent RGBA frame and piped raw
 * into ffmpeg, which lays them over the background (and the clip, when there is one).
 */
export async function renderScene(spec: SceneSpec, out: string, ffmpegBin: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const work = fs.mkdtempSync(path.join(process.cwd(), ".ameublo-scene-"));
  try {
    const bgFile = path.join(work, "bg.png");
    fs.writeFileSync(bgFile, spec.background);
    const blank = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

    const args = ["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-t", String(spec.duration), "-i", bgFile];
    let idx = 1;
    let clipIdx = -1;
    if (spec.clip) {
      args.push("-ss", String(spec.clip.start ?? 0), "-t", String(spec.duration), "-i", spec.clip.file);
      clipIdx = idx++;
    }
    args.push("-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-framerate", String(FPS), "-i", "pipe:0");
    const layerIdx = idx++;
    let audioIdx = -1;
    if (spec.music) {
      args.push("-stream_loop", "-1", "-i", spec.music);
      audioIdx = idx++;
    } else {
      args.push("-f", "lavfi", "-t", String(spec.duration), "-i", "anullsrc=r=44100:cl=stereo");
      audioIdx = idx++;
    }
    const graph: string[] = [];
    let base = "0:v";
    if (spec.clip) {
      const c = spec.clip;
      graph.push(`[${clipIdx}:v]fps=${FPS},scale=${c.w}:${c.h}:force_original_aspect_ratio=increase,crop=${c.w}:${c.h},setsar=1[clip]`);
      graph.push(`[0:v][clip]overlay=${c.x}:${c.y}:eof_action=repeat[withclip]`);
      base = "withclip";
    }
    graph.push(`[${base}][${layerIdx}:v]overlay=0:0:format=auto,format=yuv420p[vout]`);
    const vol = spec.musicVolume ?? 0.55;
    graph.push(`[${audioIdx}:a]volume=${vol},afade=t=out:st=${Math.max(0, spec.duration - 1)}:d=1,atrim=0:${spec.duration}[aout]`);
    args.push(
      "-filter_complex", graph.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-t", String(spec.duration),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
    );

    const proc = spawn(ffmpegBin, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    const done = new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-400)}`))));
    });
    // EPIPE when ffmpeg dies early: surface ffmpeg's own error through `done`.
    proc.stdin.on("error", () => {});

    const n = Math.round(spec.duration * FPS);
    for (let i = 0; i < n; i++) {
      const layers = await spec.layersAt(i / FPS);
      const frame = await sharp(blank).composite(layers).raw().toBuffer();
      if (!proc.stdin.write(frame)) await new Promise((r) => proc.stdin.once("drain", r));
    }
    proc.stdin.end();
    await done;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ── choreography helpers ─────────────────────────────────────────────────────

const pose = (p: Partial<AmeubloPose>, accessory: AmeubloAccessory, t: number): AmeubloPose => ({
  ...NEUTRAL_POSE,
  look: { dx: 0, dy: 0 },
  squash: 1 - 0.015 * Math.sin((t * 2 * Math.PI) / 3.6),
  accessory,
  ...p,
});
const entrance = (t: number, at = 0, d = 0.5) => (1 - easeOutBack(prog(t, at, d))) * 120;
const waving = (t: number) => ({ armLift: 1, armAngle: 8 + 14 * Math.sin(t * 2 * Math.PI * 1.6) });
const hop = (t: number, rate = 2.5, height = 8) => -height * Math.abs(Math.sin(t * Math.PI * rate));
const blink = (t: number) => (t % 3.2) < 0.12;

export interface StyleProduct {
  sku: string;
  title: string;
  price: number | null;
}

/**
 * Kinetic text: the words of `text` appear one after another from `at`, `perWord` seconds
 * apart, each fading in while rising a little. Lines wrap at `maxW`, centred on the frame.
 */
export async function popWords(text: string, top: number, at: number, t: number, o: { size: number; color: string; perWord?: number; maxW?: number }): Promise<OverlayOptions[]> {
  if (t < at) return [];
  const per = o.perWord ?? 0.12;
  const maxW = o.maxW ?? W - 120;
  // Split on plain spaces only, so a no-break space ("170 $") keeps a number with its unit.
  const words = text.split(/ +/).filter(Boolean);
  const imgs = await Promise.all(words.map((w) => textImg(w, o.size, o.color)));
  const space = Math.round(o.size * 0.3);
  // Lay out lines first, at full opacity, then draw each word with its own fade.
  const lines: { idx: number[]; w: number }[] = [{ idx: [], w: 0 }];
  imgs.forEach((im, i) => {
    const cur = lines[lines.length - 1];
    const add = (cur.idx.length ? space : 0) + im.w;
    if (cur.w + add > maxW && cur.idx.length) lines.push({ idx: [i], w: im.w });
    else { cur.idx.push(i); cur.w += add; }
  });
  const gap = Math.round(o.size * 1.18);
  const out: OverlayOptions[] = [];
  for (let li = 0; li < lines.length; li++) {
    let x = Math.round((W - lines[li].w) / 2);
    for (const i of lines[li].idx) {
      const k = prog(t, at + i * per, 0.14);
      if (k > 0) {
        const im = k >= 1 ? imgs[i] : await textImg(words[i], o.size, o.color, 700, k);
        out.push({ input: im.buf, left: x, top: Math.round(top + li * gap + (1 - easeOut(k)) * 18) });
      }
      x += imgs[i].w + space;
    }
  }
  return out;
}

/** A white flash for hard cuts (opacity 0–1), full frame. */
function flash(opacity: number): OverlayOptions[] {
  if (opacity <= 0.01) return [];
  return [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff" opacity="${opacity.toFixed(2)}"/></svg>`), left: 0, top: 0 }];
}

/** Price that slams in: starts 35 % bigger and settles, with the free-shipping line under it. */
async function priceSlam(price: number, cx: number, top: number, t: number, at: number, subColor: string): Promise<OverlayOptions[]> {
  if (t < at) return [];
  const k = easeOutBack(prog(t, at, 0.35));
  const scale = 1 + 0.35 * (1 - Math.min(1, k));
  return priceTagLayer(priceFr(price), cx, top - (scale - 1) * 60, "LIVRAISON GRATUITE", Math.round(scale * 20) / 20, subColor);
}

// ── style: reaction ─────────────────────────────────────────────────────────

/**
 * A customer clip in a framed card, Ameublo reacting under it.
 * Beats: hook (curiosity) → value line → price teaser → price slam → call to action.
 */
export async function reactionScene(clipFile: string, p: StyleProduct, lines: AmeubloLines, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  const duration = 12;
  const card = { x: 70, y: 130, w: 940, h: 1160 };
  // A thick navy rounded frame over the clip box rounds its corners and frames it.
  const frame: OverlayOptions = {
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
        `<path fill="${NAVY}" fill-rule="evenodd" d="M${card.x - 4} ${card.y - 4}h${card.w + 8}v${card.h + 8}h-${card.w + 8}z ` +
        `M${card.x + 40} ${card.y}h${card.w - 80}a40 40 0 0 1 40 40v${card.h - 80}a40 40 0 0 1 -40 40h-${card.w - 80}a40 40 0 0 1 -40 -40v-${card.h - 80}a40 40 0 0 1 40 -40z"/>` +
        `<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="40" fill="none" stroke="${GOLD}" stroke-width="6"/></svg>`,
    ),
    left: 0,
    top: 0,
  };
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1790, { size: 40, color: GOLD, cx: 790 });
  const size = 660;
  const bx = 500;
  const bubble = (text: string, at: number, end: number, t: number, y = 1340) =>
    t >= at && t < end ? bubbleLayer(wrap(text, 14, 2), bx, y, 540, 60, bx + 40, prog(t, at, 0.12) * (1 - prog(t, end - 0.12, 0.12))) : Promise.resolve([]);
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    clip: { file: clipFile, ...card, start: 2 },
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [frame, ...url];
      let ps: AmeubloPose;
      if (t < 0.5) ps = pose({ bodyY: entrance(t, 0, 0.45), eyes: "happy" }, accessory, t);
      else if (t < 2.8) ps = pose({ eyes: "wide", mouth: "o", tilt: 5, look: { dx: 1.5, dy: -2 } }, accessory, t);
      else if (t < 5.4) ps = pose({ eyes: "happy", mouth: "laugh", bodyY: hop(t - 2.8, 3, 7), tilt: 3 * Math.sin(t * 9) }, accessory, t);
      else if (t < 7.0) ps = pose({ think: true, look: { dx: 1.6, dy: -2.2 }, mouth: "o", tilt: -3 }, accessory, t);
      else if (t < 7.6) ps = pose({ eyes: "wide", mouth: "laugh", bodyY: hop(t - 7, 3.3, 10) }, accessory, t);
      else if (t < 9.6) {
        const k = prog(t, 7.6, 0.2);
        ps = pose({ armLift: k, armAngle: 30 * k, look: { dx: 2, dy: -1 }, mouth: "smile", eyes: blink(t) ? "closed" : "open" }, accessory, t);
      } else ps = pose({ ...waving(t - 9.6), eyes: "happy", mouth: "laugh", bodyY: hop(t - 9.6, 2.5, 6) }, accessory, t);
      L.push(ameubloLayer(ps, size, -40, 1250));
      L.push(...(await bubble(lines.hook, 0.55, 2.8, t)));
      L.push(...(await bubble(lines.value, 2.95, 5.4, t)));
      L.push(...(await bubble(lines.teaser, 5.55, 7.0, t)));
      if (p.price != null) L.push(...(await priceSlam(p.price, 790, 1450, t, 7.0, "#ffffff")));
      L.push(...(await bubble(lines.cta, 9.6, 12, t, 1262)));
      return L;
    },
  };
}

// ── style: vitrine (fast) ───────────────────────────────────────────────────

/**
 * Fast product showcase: a hard cut with a punch-in every 0.9 s, kinetic hook text,
 * price slam at 4.8 s. Mat (2026-10-03): the first version was too slow.
 * Photos: the white-background shot first (the whole piece, always readable), then the rest.
 */
export async function vitrineScene(photos: Buffer[], p: StyleProduct, lines: AmeubloLines, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  const duration = 8.5;
  const cardW = 920;
  const cardH = 920;
  const cx = (W - cardW) / 2;
  const cy = 360;
  const cards = await Promise.all(photos.slice(0, 4).map((ph) => photoCard(ph, cardW, cardH, 44)));
  const sharp = (await import("sharp")).default;
  const CUT = 0.9;
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1800, { size: 44, color: NAVY });
  return {
    duration,
    background: await backgroundPng(CREAM, "#F1E2C2"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [];
      // Photos: a cut every CUT seconds, each one punching in from 110 % and settling.
      const shot = Math.floor(t / CUT);
      const local = t - shot * CUT;
      const img = cards[shot % cards.length];
      const zoom = 1 + 0.1 * (1 - easeOut(prog(local, 0, 0.25)));
      const zw = Math.round(cardW * zoom);
      const zh = Math.round(cardH * zoom);
      const zoomed = zoom > 1.001
        ? await sharp(img).resize(zw, zh).extract({ left: Math.round((zw - cardW) / 2), top: Math.round((zh - cardH) / 2), width: cardW, height: cardH }).png().toBuffer()
        : img;
      L.push({ input: zoomed, left: cx, top: cy });
      // Kinetic copy in the top band: hook → value → teaser, then the price takes over.
      if (t < 1.9) L.push(...(await popWords(lines.hook, 130, 0.05, t, { size: 76, color: NAVY, perWord: 0.1 })));
      else if (t < 3.6) L.push(...(await popWords(lines.value, 130, 1.9, t, { size: 76, color: NAVY, perWord: 0.1 })));
      else if (t < 4.8) L.push(...(await popWords(lines.teaser, 130, 3.6, t, { size: 76, color: GOLD, perWord: 0.12 })));
      else L.push(...(await popWords(lines.cta, 130, 6.4, t, { size: 76, color: NAVY, perWord: 0.1 })));
      if (p.price != null) L.push(...(await priceSlam(p.price, 330, 1330, t, 4.8, NAVY)));
      // Ameublo bottom-right: points at the card, jumps at the price, waves at the end.
      let ps: AmeubloPose;
      if (t < 0.4) ps = pose({ bodyY: entrance(t, 0, 0.4), eyes: "happy" }, accessory, t);
      else if (t < 4.8) {
        const k = prog(t, 0.4, 0.2);
        ps = pose({ leftArmLift: k, leftArmAngle: -38 * k + (local < 0.15 ? -8 : 0), look: { dx: -2, dy: -2 }, mouth: local < 0.3 ? "o" : "smile", bodyY: local < 0.2 ? -4 : 0 }, accessory, t);
      } else if (t < 5.5) ps = pose({ eyes: "wide", mouth: "laugh", bodyY: hop(t - 4.8, 3.3, 10) }, accessory, t);
      else ps = pose({ ...waving(t - 5.5), eyes: "happy", mouth: "laugh" }, accessory, t);
      L.push(ameubloLayer(ps, 500, 580, 1300));
      if (t >= 6.2) L.push(...url);
      L.push(...flash(local < 0.07 && shot > 0 ? 0.35 * (1 - local / 0.07) : 0));
      return L;
    },
  };
}

// ── style: astuce (fast) ────────────────────────────────────────────────────

/** Practical tips by product family. Plain advice, no product claims. */
export const TIPS: { match: RegExp; tip: string }[] = [
  { match: /sofa|loveseat|canap|couch|causeuse/i, tip: "Mesurez vos portes et votre escalier avant de choisir un sofa" },
  { match: /coffee table|table basse|table à café/i, tip: "Une table basse fait idéalement les deux tiers de la longueur du sofa" },
  { match: /desk|bureau/i, tip: "Placez le haut de votre écran à la hauteur des yeux pour épargner votre cou" },
  { match: /christmas|sapin|noël/i, tip: "Ouvrez les branches du sapin de bas en haut : il paraîtra bien plus fourni" },
  { match: /mirror|miroir|vanity|coiffeuse/i, tip: "Un miroir face à une fenêtre double la lumière de la pièce" },
  { match: /kids|enfant|toy|jouet/i, tip: "Des bacs bas et légers : les enfants rangent mieux quand c’est facile" },
  { match: /dog|cat|pet|chien|chat/i, tip: "Installez le coin de votre animal loin des courants d’air" },
  { match: /cabinet|sideboard|buffet|pantry|armoire|storage|rangement|bookcase|bibliothèque/i, tip: "Fixez les grands meubles de rangement au mur, surtout avec des enfants" },
];
export const DEFAULT_TIP = "Mesurez deux fois, commandez une fois";

export function tipFor(text: string): string {
  return TIPS.find((t) => t.match.test(text))?.tip ?? DEFAULT_TIP;
}

/**
 * "L'astuce d'Ameublo", faster: think (0.7 s), the tip line by line, then the product
 * punches in with its price. The photo is the white-background shot, so the piece is
 * always fully visible (a close-up lifestyle crop hid the desk in v1).
 */
export async function astuceScene(photo: Buffer, p: StyleProduct & { productType?: string | null }, lines: AmeubloLines, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  const duration = 9;
  const tip = tipFor(`${p.productType ?? ""} ${p.title}`);
  const tipLines = wrap(tip.toUpperCase(), 22, 5);
  const card = await photoCard(photo, 820, 820, 40);
  const header = await textLayer(["L’ASTUCE D’AMEUBLO"], 110, { size: 64, color: GOLD });
  const sugg = await textLayer(["NOTRE SUGGESTION"], 250, { size: 40, color: GOLD });
  const title = await textLayer(wrap(p.title.toUpperCase(), 30, 2), 1130, { size: 42, color: "#ffffff" });
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1810, { size: 44, color: GOLD });
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [...header];
      const shrink = easeOut(prog(t, 4.5, 0.35));
      const size = lerp(720, 480, shrink);
      const x = lerp((W - 720) / 2, 0, shrink);
      const y = lerp(1150, 1360, shrink);
      let ps: AmeubloPose;
      if (t < 0.35) ps = pose({ bodyY: entrance(t, 0, 0.35), eyes: "happy" }, accessory, t);
      else if (t < 1.0) ps = pose({ think: true, look: { dx: 1.6, dy: -2.2 }, mouth: "o", tilt: -3 }, accessory, t);
      else if (t < 4.5) ps = pose({ armLift: prog(t, 1, 0.15), armAngle: 20 * prog(t, 1, 0.15), eyes: t < 1.3 ? "wide" : blink(t) ? "closed" : "open", mouth: "smile" }, accessory, t);
      else if (t < 5.4) ps = pose({ eyes: "wide", mouth: "laugh", bodyY: hop(t - 4.5, 3, 7) }, accessory, t);
      else if (t < 7.4) {
        const k = prog(t, 5.4, 0.2);
        ps = pose({ armLift: k, armAngle: 34 * k, look: { dx: 2, dy: -2 }, eyes: blink(t) ? "closed" : "open" }, accessory, t);
      } else ps = pose({ ...waving(t - 7.4), eyes: "happy", mouth: "laugh", bodyY: hop(t - 7.4, 2.5, 6) }, accessory, t);
      if (t >= 1.0 && t < 4.5) {
        // The bubble opens, then the tip arrives line by line (0.22 s apart).
        const a = prog(t, 1.0, 0.12) * (1 - prog(t, 4.35, 0.15));
        const shown = tipLines.map((l, i) => (t >= 1.05 + i * 0.22 ? l : " "));
        L.push(...(await bubbleLayer(shown, 90, 300, 900, 64, 560, a)));
      }
      if (t >= 4.5) {
        const k = easeOut(prog(t, 4.5, 0.3));
        const zoom = 1 + 0.12 * (1 - k);
        const cw = Math.round(820 * zoom);
        const sharp = (await import("sharp")).default;
        const img = zoom > 1.001 ? await sharp(card).resize(cw, cw).extract({ left: Math.round((cw - 820) / 2), top: Math.round((cw - 820) / 2), width: 820, height: 820 }).png().toBuffer() : card;
        L.push(...sugg, { input: img, left: Math.round((W - 820) / 2), top: 300 }, ...title);
        if (p.price != null) L.push(...(await priceSlam(p.price, 720, 1440, t, 5.3, "#ffffff")));
        if (t >= 6.8) L.push(...url);
        L.push(...flash(t < 4.57 ? 0.4 * (1 - (t - 4.5) / 0.07) : 0));
      }
      L.push(ameubloLayer(ps, size, x, y));
      return L;
    },
  };
}

// ── shared: a photo card that punches in on a cut ───────────────────────────

async function punchCard(card: Buffer, size: number, local: number): Promise<Buffer> {
  const zoom = 1 + 0.1 * (1 - easeOut(prog(local, 0, 0.25)));
  if (zoom <= 1.001) return card;
  const sharp = (await import("sharp")).default;
  const z = Math.round(size * zoom);
  return sharp(card).resize(z, z).extract({ left: Math.round((z - size) / 2), top: Math.round((z - size) / 2), width: size, height: size }).png().toBuffer();
}

/** Round gold badge with a label (A, B, #1, 3…). */
async function badge(label: string, cx: number, cy: number, d: number, fill = GOLD, color = NAVY): Promise<OverlayOptions[]> {
  const im = await textImg(label, Math.round(d * 0.5), color);
  return [
    { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - 3}" fill="${fill}" stroke="${NAVY}" stroke-width="5"/></svg>`), left: Math.round(cx - d / 2), top: Math.round(cy - d / 2) },
    { input: im.buf, left: Math.round(cx - im.w / 2), top: Math.round(cy - im.h / 2) },
  ];
}

// ── style: devine le prix ───────────────────────────────────────────────────

/**
 * A believable decoy for "Devine le prix": the real price scaled down or up, ending in .99.
 * It is shown as one of two guesses, never as a former price.
 */
export function decoyPrice(real: number, sku: string): number {
  let h = 0;
  for (const ch of sku) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const k = h % 2 === 0 ? 0.45 : 2.2;
  return Math.max(9.99, Math.round(real * k) - 0.01);
}

/**
 * "Devine le prix": two prices on screen, a 3-2-1 countdown over quick product cuts, then
 * the real price is revealed. Curiosity loop + one-letter comments ("A !").
 */
export async function devinePrixScene(photos: Buffer[], p: StyleProduct, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  if (p.price == null) throw new Error("devine-le-prix needs a price");
  const duration = 10;
  const S = 820;
  const cards = await Promise.all(photos.slice(0, 4).map((ph) => photoCard(ph, S, S, 40)));
  const real = p.price;
  const decoy = decoyPrice(real, p.sku);
  const realIsA = (real < decoy) === (p.sku.length % 2 === 0);
  const opts: [string, number][] = realIsA ? [["A", real], ["B", decoy]] : [["A", decoy], ["B", real]];
  const header = await textLayer(["DEVINE LE PRIX"], 110, { size: 80, color: GOLD });
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1800, { size: 44, color: GOLD });
  const REVEAL = 6.2;
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [...header];
      const CUT = 1.2;
      const shot = Math.floor(Math.min(t, REVEAL - 0.01) / CUT);
      const local = t >= REVEAL ? t - REVEAL : t - shot * CUT;
      const img = t >= REVEAL ? cards[0] : cards[shot % cards.length];
      L.push({ input: await punchCard(img, S, local), left: (W - S) / 2, top: 250 });
      // The two guesses; at the reveal the real one turns into a gold tag, the other is struck out.
      if (t >= 0.5) {
        for (let i = 0; i < 2; i++) {
          const [letter, v] = opts[i];
          const label = `${letter} : ${priceFr(v)}`;
          const cx = i === 0 ? 290 : 790;
          const isReal = v === real;
          if (t >= REVEAL && isReal) {
            const grow = 1 + 0.15 * easeOutBack(prog(t, REVEAL, 0.3));
            L.push(...(await priceTagLayer(label, cx, 1090, undefined, Math.round(0.6 * grow * 20) / 20)));
          } else if (t >= REVEAL) {
            const im = await textImg(label, 54, "#8A94A8");
            L.push(...(await textLayer([label], 1110, { size: 54, color: "#8A94A8", cx })));
            L.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${im.w + 20}" height="8"><rect width="${im.w + 20}" height="8" rx="4" fill="#E9897E"/></svg>`), left: Math.round(cx - im.w / 2 - 10), top: 1146 });
          } else {
            L.push(...(await textLayer([label], 1110, { size: 54, color: "#ffffff", cx, opacity: prog(t, 0.5 + i * 0.15, 0.2) })));
          }
        }
      }
      // Countdown 3-2-1 in a badge on the card.
      if (t >= 4.4 && t < REVEAL) {
        const n = 3 - Math.floor((t - 4.4) / 0.6);
        L.push(...(await badge(String(n), 900, 300, 140)));
      }
      if (t >= REVEAL) L.push(...(await popWords("LE VRAI PRIX !", 1250, REVEAL + 0.1, t, { size: 64, color: "#ffffff", perWord: 0.1 })));
      if (t >= 8.0) L.push(...(await popWords("TU AVAIS DEVINÉ ? DIS-LE EN COMMENTAIRE", 1380, 8.0, t, { size: 46, color: GOLD, perWord: 0.07, maxW: 620 })), ...url);
      // Ameublo: curious, thinks through the countdown, jumps at the reveal.
      let ps: AmeubloPose;
      if (t < 0.4) ps = pose({ bodyY: entrance(t, 0, 0.4), eyes: "happy" }, accessory, t);
      else if (t < 4.4) ps = pose({ look: { dx: 2 * Math.sin(t * 2.5), dy: -1.5 }, mouth: "smile", eyes: blink(t) ? "closed" : "open" }, accessory, t);
      else if (t < REVEAL) ps = pose({ think: true, look: { dx: 1.6, dy: -2.2 }, mouth: "o", tilt: -3 + 2 * Math.sin(t * 12) }, accessory, t);
      else if (t < REVEAL + 0.9) ps = pose({ eyes: "wide", mouth: "laugh", bodyY: hop(t - REVEAL, 3.3, 12) }, accessory, t);
      else ps = pose({ ...waving(t - REVEAL - 0.9), eyes: "happy", mouth: "laugh" }, accessory, t);
      L.push(ameubloLayer(ps, 460, 640, 1360));
      L.push(...flash(t >= REVEAL && t < REVEAL + 0.08 ? 0.5 * (1 - (t - REVEAL) / 0.08) : 0));
      return L;
    },
  };
}

// ── style: tu prends lequel ? (A ou B) ──────────────────────────────────────

/**
 * Two products side by side; the spotlight alternates A / B every 1.3 s while Ameublo
 * points at each, then "ÉCRIS A OU B". A one-letter comment costs nothing to leave.
 */
export async function ceciOuCaScene(photoA: Buffer, photoB: Buffer, a: StyleProduct, b: StyleProduct, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  const duration = 10;
  const CW = 500;
  const CH = 640;
  const cards = [await photoCard(photoA, CW, CH, 36), await photoCard(photoB, CW, CH, 36)];
  const prods = [a, b];
  const header = await textLayer(["TU PRENDS LEQUEL ?"], 110, { size: 78, color: NAVY });
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1800, { size: 44, color: NAVY });
  const sharp = (await import("sharp")).default;
  const dimmer = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}"><rect width="${CW}" height="${CH}" rx="36" fill="#FBF3E2" opacity=".55"/></svg>`)).png().toBuffer();
  const ring = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW + 24}" height="${CH + 24}"><rect x="5" y="5" width="${CW + 14}" height="${CH + 14}" rx="44" fill="none" stroke="${GOLD}" stroke-width="10"/></svg>`);
  const xs = [30, 550];
  const top = 290;
  return {
    duration,
    background: await backgroundPng(CREAM, "#F1E2C2"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [...header];
      // Spotlight: A, B, A, B between 1.0 and 6.2 s (-1 = both).
      const phase = t >= 1.0 && t < 6.2 ? Math.floor((t - 1.0) / 1.3) % 2 : -1;
      for (const i of [0, 1]) {
        const k = easeOut(prog(t, 0.15 + i * 0.12, 0.3));
        const x = Math.round(xs[i] + (i === 0 ? -1 : 1) * (1 - k) * 300);
        if (phase === i) L.push({ input: ring, left: Math.max(0, x - 12), top: top - 12 });
        L.push({ input: cards[i], left: Math.max(0, Math.min(W - CW, x)), top });
        if (phase === 1 - i) L.push({ input: dimmer, left: x, top });
        L.push(...(await badge(i === 0 ? "A" : "B", x + 70, top + 70, 100)));
        const pr = prods[i];
        if (pr.price != null) L.push(...(await priceTagLayer(priceFr(pr.price), xs[i] + CW / 2, top + CH + 30, undefined, 0.62)));
        L.push(...(await textLayer(wrap(pr.title.toUpperCase(), 22, 2), top + CH + 150, { size: 32, color: NAVY, cx: xs[i] + CW / 2 })));
      }
      if (t >= 6.3) L.push(...(await popWords("ÉCRIS A OU B EN COMMENTAIRE", 1300, 6.3, t, { size: 58, color: NAVY, perWord: 0.09, maxW: 560 })));
      if (t >= 7.5) L.push(...url);
      let ps: AmeubloPose;
      if (t < 0.4) ps = pose({ bodyY: entrance(t, 0, 0.4), eyes: "happy" }, accessory, t);
      else if (phase === 0) ps = pose({ leftArmLift: 1, leftArmAngle: -38, look: { dx: -2, dy: -2 }, mouth: "o" }, accessory, t);
      else if (phase === 1) ps = pose({ armLift: 1, armAngle: 38, look: { dx: 2, dy: -2 }, mouth: "o" }, accessory, t);
      else if (t < 6.2) ps = pose({ look: { dx: 0, dy: -2 }, mouth: "smile" }, accessory, t);
      else ps = pose({ think: true, look: { dx: 1.6, dy: -2.2 }, mouth: "smile", tilt: 3 * Math.sin(t * 3) }, accessory, t);
      L.push(ameubloLayer(ps, 440, 640, 1380));
      return L;
    },
  };
}

// ── style: top 3 ────────────────────────────────────────────────────────────

/** "3 TROUVAILLES SOUS 120 $": the cap is the next $10 above the dearest of the three, so it is true. */
export function top3Cap(prices: number[]): number {
  return Math.ceil(Math.max(...prices) / 10) * 10;
}

/** Top 3 countdown: a teaser of all three, then #3, #2, #1 (~2.4 s each) with cut, rank, photo and price. */
export async function top3Scene(items: { photo: Buffer; p: StyleProduct }[], accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  if (items.length !== 3 || items.some((i) => i.p.price == null)) throw new Error("top3 needs 3 priced products");
  const duration = 10;
  const S = 840;
  const cards = await Promise.all(items.map((i) => photoCard(i.photo, S, S, 40)));
  const sharp = (await import("sharp")).default;
  const minis = await Promise.all(cards.map((c) => sharp(c).resize(300, 300).png().toBuffer()));
  const cap = top3Cap(items.map((i) => i.p.price as number));
  const hook = `3 TROUVAILLES SOUS ${cap} $`;
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1800, { size: 44, color: GOLD });
  const START = 1.2;
  const EACH = 2.4;
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [];
      L.push(...(await popWords(hook, 110, 0.05, t, { size: 72, color: GOLD, perWord: 0.1 })));
      const slot = t < START ? -1 : Math.min(2, Math.floor((t - START) / EACH));
      const local = slot >= 0 ? t - START - slot * EACH : t;
      if (slot >= 0) {
        const idx = 2 - slot; // #3 first, #1 last
        const item = items[idx];
        L.push({ input: await punchCard(cards[idx], S, local), left: (W - S) / 2, top: 290 });
        L.push(...(await badge(`#${idx + 1}`, 190, 340, 150)));
        L.push(...(await textLayer(wrap(item.p.title.toUpperCase(), 28, 2), 1160, { size: 44, color: "#ffffff" })));
        L.push(...(await priceSlam(item.p.price as number, W / 2, 1300, t, START + slot * EACH + 0.3, "#ffffff")));
        L.push(...flash(local < 0.07 ? 0.4 * (1 - local / 0.07) : 0));
      } else {
        // Before #3: a quick teaser of all three.
        const k = easeOut(prog(t, 0.2, 0.4));
        minis.forEach((c, i) => L.push({ input: c, left: Math.max(0, Math.round(45 + i * 340 - (1 - k) * 40)), top: 620 }));
      }
      if (t >= 8.9) L.push(...(await popWords("TON PRÉFÉRÉ ?", 1520, 8.9, t, { size: 56, color: GOLD, perWord: 0.1 })), ...url);
      let ps: AmeubloPose;
      if (t < 0.4) ps = pose({ bodyY: entrance(t, 0, 0.4), eyes: "happy" }, accessory, t);
      else if (slot === 2 && local < 0.8) ps = pose({ eyes: "wide", mouth: "laugh", bodyY: hop(local, 3.3, 12) }, accessory, t);
      else if (slot >= 0 && local < 0.5) ps = pose({ eyes: "wide", mouth: "o", bodyY: hop(local, 2, 6) }, accessory, t);
      else if (t >= 8.9) ps = pose({ ...waving(t - 8.9), eyes: "happy", mouth: "laugh" }, accessory, t);
      else ps = pose({ armLift: 1, armAngle: 30, look: { dx: 2, dy: -2 }, mouth: "smile", eyes: blink(t) ? "closed" : "open" }, accessory, t);
      L.push(ameubloLayer(ps, 420, 660, 1380));
      return L;
    },
  };
}
