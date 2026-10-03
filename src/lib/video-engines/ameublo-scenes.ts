/**
 * Ameublo video STYLES — full-frame scenes starring the mascot, all free (sharp + ffmpeg,
 * no AI call). Each style is a pure "what is on screen at time t" function; `renderScene`
 * rasterises it frame by frame and pipes raw RGBA to ffmpeg.
 *
 *   reaction — a customer clip in a card, Ameublo reacting under it (wow → laugh → points).
 *   vitrine  — product photos on a card, Ameublo presenting them, price tag drops in.
 *   astuce   — "L'astuce d'Ameublo": he thinks, shares a practical tip, then suggests a product.
 *   bumper   — wraps an existing ad: 1.6 s intro card + the ad + 2.4 s outro card.
 *
 * Review only for now (Studio Ameublo, scripts/ameublo-style-samples.mts).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OverlayOptions } from "sharp";
import { ameubloSvg, NEUTRAL_POSE, type AmeubloPose, type AmeubloAccessory } from "@/lib/ameublo-sprite";

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

/** Concatenate MP4s of identical size/fps (re-encoded, audio included). */
export async function concatClips(files: string[], out: string, ffmpegBin: string): Promise<void> {
  const inputs = files.flatMap((f) => ["-i", f]);
  const streams = files.map((_, i) => `[${i}:v]fps=${FPS},scale=${W}:${H},setsar=1[v${i}];[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`).join(";");
  const cat = files.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${files.length}:v=1:a=1[v][a]`;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegBin, ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", `${streams};${cat}`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`concat ${c}: ${err.slice(-400)}`))));
  });
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

// ── style: reaction ─────────────────────────────────────────────────────────

export async function reactionScene(clipFile: string, p: StyleProduct, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
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
  const ax = -40;
  const ay = 1250;
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    clip: { file: clipFile, ...card, start: 2 },
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [frame, ...url];
      let ps: AmeubloPose;
      if (t < 0.6) ps = pose({ bodyY: entrance(t), eyes: "happy" }, accessory, t);
      else if (t < 3.2) ps = pose({ eyes: "wide", mouth: "o", tilt: 5 * Math.sin(prog(t, 0.6, 0.3) * Math.PI / 2), look: { dx: 1.5, dy: -2 } }, accessory, t);
      else if (t < 6.2) ps = pose({ eyes: "happy", mouth: "laugh", bodyY: hop(t - 3.2, 3, 7), tilt: 3 * Math.sin(t * 9) }, accessory, t);
      else if (t < 10) {
        const k = prog(t, 6.2, 0.2);
        ps = pose({ armLift: k, armAngle: 30 * k, look: { dx: 2, dy: -2 }, mouth: "smile", eyes: blink(t) ? "closed" : "open" }, accessory, t);
      } else ps = pose({ ...waving(t - 10), eyes: "happy", mouth: "laugh", bodyY: hop(t - 10, 2.5, 6) }, accessory, t);
      L.push(ameubloLayer(ps, size, ax, ay));
      // Bubbles: wow → love → (price takes over).
      const bx = 500;
      if (t >= 0.8 && t < 3.2) L.push(...(await bubbleLayer(["OH !", "REGARDEZ ÇA"], bx, 1360, 520, 62, bx + 40, prog(t, 0.8, 0.15))));
      if (t >= 3.4 && t < 6.2) L.push(...(await bubbleLayer(["J’ADORE !"], bx + 40, 1400, 440, 72, bx + 80, prog(t, 3.4, 0.15))));
      if (t >= 6.4 && p.price != null) {
        const k = easeOutBack(prog(t, 6.4, 0.45));
        L.push(...(await priceTagLayer(priceFr(p.price), 790, 1440 - (1 - k) * 60, "LIVRAISON GRATUITE", 0.95, "#ffffff")));
      }
      return L;
    },
  };
}

// ── style: vitrine ──────────────────────────────────────────────────────────

export async function vitrineScene(photos: Buffer[], p: StyleProduct, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  const duration = 12;
  const cardW = 860;
  const cardH = 860;
  const cx = (W - cardW) / 2;
  const cy = 300;
  const cards = await Promise.all(photos.slice(0, 3).map((ph) => photoCard(ph, cardW, cardH, 44)));
  const sharp = (await import("sharp")).default;
  const shadow = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW + 80}" height="${cardH + 80}"><defs><filter id="b"><feGaussianBlur stdDeviation="18"/></filter></defs>` +
      `<rect x="40" y="52" width="${cardW}" height="${cardH}" rx="44" fill="#1B2A47" opacity=".28" filter="url(#b)"/></svg>`,
  )).png().toBuffer();
  const header = await textLayer(["LA VITRINE D’AMEUBLO"], 120, { size: 62, color: NAVY });
  const title = await textLayer(wrap(p.title.toUpperCase(), 26, 2), 1195, { size: 50, color: NAVY });
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1800, { size: 44, color: NAVY });
  const per = 3;
  return {
    duration,
    background: await backgroundPng(CREAM, "#F1E2C2"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [...header];
      // Photos: each slides in from the right and settles, with a slow push-in.
      const i = Math.min(cards.length - 1, Math.floor(Math.max(0, t - 0.4) / per));
      const local = t - 0.4 - i * per;
      const slide = (1 - easeOut(prog(local, 0, 0.35))) * 160;
      const zoom = 1 + 0.04 * clamp01(local / per);
      const zw = Math.round(cardW * zoom);
      const zh = Math.round(cardH * zoom);
      const zoomed = await sharp(cards[i]).resize(zw, zh).extract({ left: Math.round((zw - cardW) / 2), top: Math.round((zh - cardH) / 2), width: cardW, height: cardH }).png().toBuffer();
      if (t >= 0.4) {
        const left = Math.round(cx + Math.min(slide, W - cx - cardW));
        L.push({ input: shadow, left: left - 40, top: cy - 40 }, { input: zoomed, left, top: cy });
      }
      L.push(...title);
      // Ameublo bottom-right presenting the card with his left arm; waves at the end.
      let ps: AmeubloPose;
      if (t < 0.5) ps = pose({ bodyY: entrance(t), eyes: "happy" }, accessory, t);
      else if (t < 9.6) {
        const k = prog(t, 0.6, 0.25);
        const nudge = local < 0.3 ? -0.6 : 0; // little lift each time a photo changes
        ps = pose({ leftArmLift: k, leftArmAngle: -38 * k + nudge * 10, look: { dx: -2, dy: -2 }, mouth: local < 0.4 ? "o" : "smile", eyes: blink(t) ? "closed" : "open" }, accessory, t);
      } else ps = pose({ ...waving(t - 9.6), eyes: "happy", mouth: "laugh", bodyY: hop(t - 9.6, 2.5, 6) }, accessory, t);
      L.push(ameubloLayer(ps, 540, 560, 1270));
      if (p.price != null && t >= 9.0) {
        const k = easeOutBack(prog(t, 9.0, 0.5));
        L.push(...(await priceTagLayer(priceFr(p.price), 300, 1480 - (1 - k) * 220, "LIVRAISON GRATUITE")));
      }
      if (t >= 10.2) L.push(...url);
      return L;
    },
  };
}

// ── style: astuce ───────────────────────────────────────────────────────────

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

export async function astuceScene(photo: Buffer, p: StyleProduct & { productType?: string | null }, accessory: AmeubloAccessory, music?: string): Promise<SceneSpec> {
  const duration = 13;
  const tip = tipFor(`${p.productType ?? ""} ${p.title}`);
  const tipLines = wrap(tip.toUpperCase(), 22, 5);
  const card = await photoCard(photo, 760, 760, 40);
  const header = await textLayer(["L’ASTUCE D’AMEUBLO"], 110, { size: 64, color: GOLD });
  const sugg = await textLayer(["NOTRE SUGGESTION"], 250, { size: 40, color: GOLD });
  const title = await textLayer(wrap(p.title.toUpperCase(), 30, 3), 1070, { size: 44, color: "#ffffff" });
  const url = await textLayer(["AMEUBLODIRECT.CA"], 1810, { size: 44, color: GOLD });
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    music,
    layersAt: async (t) => {
      const L: OverlayOptions[] = [...header];
      // Act 1 (0-6 s): big Ameublo thinks, then shares the tip.
      // Act 2 (6-13 s): he shrinks to the corner, the suggested product takes the stage.
      const shrink = easeOut(prog(t, 6, 0.6));
      const size = lerp(720, 500, shrink);
      const x = lerp((W - 720) / 2, 0, shrink);
      const y = lerp(1150, 1330, shrink);
      let ps: AmeubloPose;
      if (t < 0.5) ps = pose({ bodyY: entrance(t), eyes: "happy" }, accessory, t);
      else if (t < 2.0) ps = pose({ think: true, look: { dx: 1.6, dy: -2.2 }, mouth: "o", tilt: -3 }, accessory, t);
      else if (t < 6) ps = pose({ armLift: prog(t, 2, 0.2), armAngle: 20 * prog(t, 2, 0.2), eyes: t < 2.4 ? "wide" : blink(t) ? "closed" : "open", mouth: "smile" }, accessory, t);
      else if (t < 11.2) {
        const k = prog(t, 6.6, 0.25);
        ps = pose({ armLift: k, armAngle: 34 * k, look: { dx: 2, dy: -2 }, eyes: blink(t) ? "closed" : "open" }, accessory, t);
      } else ps = pose({ ...waving(t - 11.2), eyes: "happy", mouth: "laugh", bodyY: hop(t - 11.2, 2.5, 6) }, accessory, t);
      if (t >= 2.1 && t < 6) {
        const a = prog(t, 2.1, 0.2) * (1 - prog(t, 5.8, 0.2));
        L.push(...(await bubbleLayer(tipLines, 90, 300, 900, 64, 560, a)));
      }
      if (t >= 6.2) {
        const k = easeOut(prog(t, 6.2, 0.5));
        L.push(...sugg, { input: card, left: Math.round((W - 760) / 2), top: Math.round(310 + (1 - k) * 80) }, ...title);
        if (p.price != null && t >= 7.4) {
          const kk = easeOutBack(prog(t, 7.4, 0.45));
          L.push(...(await priceTagLayer(priceFr(p.price), 720, 1420 - (1 - kk) * 60, "LIVRAISON GRATUITE", 1, "#ffffff")));
        }
        if (t >= 10) L.push(...url);
      }
      L.push(ameubloLayer(ps, size, x, y));
      return L;
    },
  };
}

// ── style: bumper (intro / outro around an existing ad) ─────────────────────

export async function bumperIntro(accessory: AmeubloAccessory): Promise<SceneSpec> {
  const duration = 1.6;
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    layersAt: async (t) => [
      ameubloLayer(pose({ bodyY: entrance(t, 0, 0.45), eyes: "happy", mouth: "laugh", ...(t > 0.5 ? waving(t - 0.5) : {}) }, accessory, t), 640, (W - 640) / 2, 560),
      ...(await textLayer(["AMEUBLO", "VOUS PRÉSENTE…"], 1320, { size: 78, color: "#ffffff", opacity: prog(t, 0.45, 0.3) })),
    ],
  };
}

export async function bumperOutro(accessory: AmeubloAccessory): Promise<SceneSpec> {
  const duration = 2.4;
  return {
    duration,
    background: await backgroundPng(NAVY, "#24365C"),
    layersAt: async (t) => [
      ameubloLayer(pose({ ...waving(t), eyes: "happy", mouth: "laugh", bodyY: hop(t, 2.2, 8) }, accessory, t), 600, (W - 600) / 2, 480),
      ...(await textLayer(["À BIENTÔT !"], 1180, { size: 86, color: "#ffffff", opacity: prog(t, 0.1, 0.3) })),
      ...(await textLayer(["AMEUBLODIRECT.CA"], 1340, { size: 60, color: GOLD, opacity: prog(t, 0.3, 0.3) })),
      ...(await textLayer(["LIVRAISON GRATUITE PARTOUT AU CANADA"], 1460, { size: 40, color: "#ffffff", opacity: prog(t, 0.5, 0.3) })),
    ],
  };
}
