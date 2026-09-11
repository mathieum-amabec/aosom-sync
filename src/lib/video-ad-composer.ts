/**
 * Filtergraph composer for scroll-stopping 9:16 product ads.
 *
 * ── WHY THIS REPLACES THE v2 LAYOUT ───────────────────────────────────────
 * Three things were wrong with the ads this replaces, and each fix here is aimed at one:
 *
 * 1. THE TEXT HID THE PRODUCT. v2 centred up to 4 lines at 86 px on H/2 — dead centre, over
 *    the product — behind a 0.65 slab covering 46% of the frame, for the entire 15 s. Here
 *    text is capped at 2 lines, sized 58-72 px, and lives in a band that is chosen to AVOID
 *    the product: Claude Vision reports which third the product occupies and the band goes
 *    somewhere else. The slab is gone, replaced by a soft gradient that only darkens the band.
 *
 * 2. THE ANIMATIONS WERE INVISIBLE. A 0.3 s alpha fade under a 3.5 s hold is nothing on a
 *    phone. What the eye actually catches is a SOLID SHAPE moving and a hard cut. So: the
 *    hook reveals word by word, a gold keyline wipes its width open under the text, and a
 *    one-frame white flash punches each message change. Fades still exist, but they are no
 *    longer carrying the motion on their own.
 *
 * 3. EVERY AD SOUNDED THE SAME. Two tracks are on disk. `pickMusic` turns them into a large
 *    space — track × start offset × tempo, all derived from the SKU — so two ads in one
 *    campaign do not open on the same eight bars.
 *
 * ── AND THE OPENING BLACK CARD IS GONE ────────────────────────────────────
 * v2 opened on 0.8 s of black. On a muted autoplay feed that is 40% of the window in which a
 * thumb decides, spent showing nothing. This opens ON the footage, already pushing in, with
 * the first word landing at 0.15 s.
 *
 * ── WHAT ffmpeg 8.1.1 WILL AND WILL NOT DO (measured, not assumed) ────────
 *   works:  drawtext x/y/alpha expressions · drawbox w/h/x/y expressions (the keyline wipe)
 *           · zoompan over video (the push-in) · fade alpha on an overlay · atempo/asetrate
 *   CRASHES: an expression `fontsize`. It parses, then segfaults mid-encode (exit 139, empty
 *           stderr, truncated file). Reproduced on a bare 30-frame synthetic render, so it is
 *           the filter and not this pipeline. Any scale animation here is built from several
 *           CONSTANT-size draws instead. Do not "simplify" that back.
 *   refused: an animated alpha inside a drawbox colour (`black@'min(1,t)'`).
 */

// ── geometry ──────────────────────────────────────────────────────────────
export const W = 1080;
export const H = 1920;
/** Brand bar height, kept from the existing creative. */
export const BAR_H = 170;
export const FPS = 30;
/** Total ad length. */
export const DURATION = 15;

/** Where Vision says the product sits, so the text can go somewhere else. */
export type ProductZone = "top" | "middle" | "bottom";

/** Message windows, seconds. Hormozi order: hook, benefit, price, CTA. */
export const WINDOWS: [number, number][] = [
  [0, 3.5],
  [3.5, 7.5],
  [7.5, 11],
  [11, 15],
];

export interface TextBand {
  /** Top of the band. */
  y: number;
  height: number;
}

/**
 * Put the copy where the product is not.
 *
 * The bottom band is the default because a 9:16 product shot almost always centres the
 * object and the brand bar already anchors the bottom. When Vision reports the product IS
 * low in frame, the copy moves to the top band instead of covering it.
 */
export function textBand(zone: ProductZone): TextBand {
  // Bottom band stops clear of the brand bar (1750) with a 90 px gutter.
  if (zone === "bottom") return { y: 210, height: 400 };
  return { y: 1250, height: 410 };
}

/** Gradient covering the text band plus a soft run-up, for the scrim overlay. */
export function gradientRect(zone: ProductZone): { y: number; height: number; flip: boolean } {
  const band = textBand(zone);
  if (zone === "bottom") return { y: 0, height: band.y + band.height + 120, flip: true };
  return { y: band.y - 150, height: H - (band.y - 150), flip: false };
}

// ── music variety ─────────────────────────────────────────────────────────

/** Stable 32-bit hash. Same SKU always gets the same bed, so a re-render is reproducible. */
export function hashSku(sku: string): number {
  let h = 2166136261;
  for (let i = 0; i < sku.length; i++) {
    h ^= sku.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface MusicChoice {
  track: string;
  /** Seconds into the track to start, so two ads on one file do not share an intro. */
  startOffset: number;
  /** 0.94-1.08. Small enough to stay musical, large enough to change the feel. */
  tempo: number;
  /** Which family the bed came from, for the render log. */
  family?: string;
  /** Level-matching multiplier applied on top of the base volume. */
  gain: number;
}

/**
 * Music families, keyed to the product taxonomy.
 *
 * WHY BY CATEGORY AND NOT PURE HASH
 * Hashing across the whole catalog spreads the beds evenly, which is exactly wrong for a
 * brand: a patio ad and a dog-bed ad want different rooms, and someone who sees five of our
 * ads should hear a category, not a shuffle. So the family is chosen by what the product IS,
 * and the hash then desynchronises WITHIN that family — the same trick as before, applied one
 * level down.
 *
 * Filenames only; the caller resolves them against its own audio directory.
 */
export const MUSIC_FAMILIES: Record<string, string[]> = {
  // The two original beds stay on outdoor, which is what they were chosen for and what every
  // patio ad already published sounds like. Changing them would break a live identity.
  exterieur: [
    "joyinsound-no-copyright-chill-music-403411.mp3",
    "sigmamusicart-no-copyright-music-514564.mp3",
  ],
  // Warm lounge for the rooms people relax in.
  interieur: ["mixkit-lounge-695.mp3"],
  // Driving bed for desks, shelving and storage. mixkit-corporate-22 held this slot until
  // 2026-09-10, when it was rejected on listening as too downbeat for assembly footage —
  // which is all forward motion. Measured, it was the slowest-moving bed in the pool
  // (194 onsets/min).
  //
  // Golden Storm was picked over the livelier-sounding Motivating Mornings (id 33,
  // 215 onsets/min) on LEVEL SPREAD, not on energy. Track 33 is a build: it runs 6.6 dB
  // between its quietest and loudest entry point, so with one averaged gain two ads in the
  // same family would land 6.6 dB apart — the exact defect TRACK_GAIN exists to prevent.
  // Golden Storm holds 3.6 dB across the same eight points and still beats the retired bed
  // on energy (221 onsets/min).
  // src/audio/ is gitignored, so the file does not travel with the repo. Re-fetch:
  //   curl -L https://assets.mixkit.co/music/470/470.mp3 -o src/audio/mixkit-golden-storm-470.mp3
  // "Golden Storm" by Diego Nava, Mixkit Stock Music Free License
  // (isAccessibleForFree: true, https://mixkit.co/license/#musicFree), verified 2026-09-10.
  bureau: ["mixkit-golden-storm-470.mp3"],
  // Bright pop for toys and kids furniture.
  enfants: ["mixkit-pop-250.mp3"],
  // Playful funk for pet products.
  animaux: ["mixkit-funk-1140.mp3"],
};

/**
 * Per-track gain, because the pool is NOT level-matched.
 *
 * Measured mean_volume over the eight entry points: joyinsound sits at -9.3 dB while
 * mixkit-funk-1140 sits at -19.6 dB. Under the flat volume=0.22 the old code applied, a pet
 * ad came out roughly half as loud as a patio ad — a category identity must not also be a
 * volume difference. Each track is nudged toward a -10.5 dB reference (the level the two
 * original beds already average, so the creative that shipped barely moves).
 *
 * Multiplies the base 0.22, so the loudest result is 0.22 x 2.85 = 0.63 — no clipping.
 * Re-measure with:
 *   ffmpeg -ss <offset> -t 15 -i <track> -af volumedetect -f null -
 */
export const TRACK_GAIN: Record<string, number> = {
  "joyinsound-no-copyright-chill-music-403411.mp3": 0.87,
  "sigmamusicart-no-copyright-music-514564.mp3": 1.19,
  "mixkit-corporate-22.mp3": 1.95,
  "mixkit-golden-storm-470.mp3": 1.24,
  "mixkit-lounge-695.mp3": 2.26,
  "mixkit-pop-250.mp3": 2.02,
  "mixkit-funk-1140.mp3": 2.85,
};

/** Fallback family when the product type is unknown or matches nothing. */
export const DEFAULT_FAMILY = "exterieur";

/**
 * Map an Aosom `product_type` to a music family.
 *
 * Deliberately coarse. The point is a recognisable sound per area of the catalog, not a bed
 * per leaf category — 200 families would be the same as no families at all.
 */
export function musicFamilyFor(productType: string | null | undefined): string {
  const t = String(productType ?? "");
  if (!t) return DEFAULT_FAMILY;
  if (/^Patio & Garden/.test(t)) return "exterieur";
  if (/^Pet Supplies/.test(t)) return "animaux";
  if (/^Toys & Games/.test(t)) return "enfants";
  if (/^Office Products/.test(t) || /Storage & Organization/.test(t)) return "bureau";
  if (/^Home Furnishings/.test(t)) return "interieur";
  return DEFAULT_FAMILY;
}

/**
 * Pick the bed: family first, then the same hash-derived desynchronisation as before.
 *
 * `available` is what is actually on disk. The mp3s are gitignored, so a clone without them
 * must degrade rather than crash: when the family has no file present, this falls back to the
 * whole pool and the ad still renders with music, just not the themed one.
 *
 * The offset does most of the perceptual work. Starting one ad at 0 s and another at 36 s of
 * the same bed makes them sound like different music long before the tempo shift is noticed —
 * which is what lets one track per family carry a whole campaign.
 */
export function pickMusic(sku: string, available: string[], productType?: string | null): MusicChoice {
  if (available.length === 0) throw new Error("pickMusic: no tracks");
  const family = musicFamilyFor(productType);
  const wanted = MUSIC_FAMILIES[family] ?? [];
  const base = (p: string) => {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf(String.fromCharCode(92)));
    return i >= 0 ? p.slice(i + 1) : p;
  };
  const inFamily = available.filter((p) => wanted.includes(base(p)));
  const pool = inFamily.length ? inFamily : [...available].sort();

  const h = hashSku(sku);
  const track = pool[h % pool.length];
  // 8 distinct entry points, 6 s apart, well inside a typical 90 s-3 min bed.
  const startOffset = ((h >>> 8) % 8) * 6;
  // 8 tempo steps across 0.94-1.08.
  const tempo = Number((0.94 + ((h >>> 16) % 8) * 0.02).toFixed(2));
  return {
    track,
    startOffset,
    tempo,
    family: inFamily.length ? family : `${family} (repli)`,
    // An unlisted track keeps 1.0 rather than being silently attenuated.
    gain: TRACK_GAIN[base(track)] ?? 1,
  };
}

// ── expression helpers ────────────────────────────────────────────────────
// Commas inside a filter option must be escaped or the filtergraph parser splits on them.
const esc = (e: string) => e.replace(/,/g, "\\,");
/** 0→1 over `d` seconds from `s`. */
export const prog = (s: number, d: number) => esc(`min(1,max(0,(t-${s.toFixed(2)})/${d.toFixed(2)}))`);
/** Decelerating 0→1, for slides that should land rather than arrive. */
export const easeOut = (s: number, d: number) =>
  esc(`(1-pow(1-min(1,max(0,(t-${s.toFixed(2)})/${d.toFixed(2)})),2))`);
export const between = (a: number, b: number) => esc(`between(t,${a.toFixed(2)},${b.toFixed(2)})`);

// ── text fitting ──────────────────────────────────────────────────────────

/**
 * Wrap to AT MOST 2 lines, shrinking until it fits.
 *
 * Two lines is the cap that keeps the product visible; v2 allowed four and that is most of
 * why the frame felt covered. A message too long for two lines at the smallest size is cut
 * with an ellipsis rather than allowed to grow a third line.
 */
export function fitText(text: string, maxWidthPx = W - 150): { lines: string[]; size: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (const size of [72, 66, 60, 54, 48]) {
    // DM Sans caps run ~0.60 em wide on average.
    const perChar = size * 0.6;
    const maxChars = Math.floor(maxWidthPx / perChar);
    const lines: string[] = [];
    let cur = "";
    for (const wd of words) {
      const next = cur ? `${cur} ${wd}` : wd;
      if (next.length <= maxChars) cur = next;
      else {
        if (cur) lines.push(cur);
        cur = wd;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length <= 2 && lines.every((l) => l.length <= maxChars)) return { lines, size };
  }
  const perChar = 48 * 0.6;
  const maxChars = Math.floor(maxWidthPx / perChar);
  const flat = words.join(" ");
  const a = flat.slice(0, maxChars);
  const b = flat.slice(maxChars, maxChars * 2 - 1);
  return { lines: b ? [a, `${b}…`] : [a], size: 48 };
}

/** Approximate rendered width of a string in DM Sans caps. */
export function textWidth(s: string, size: number): number {
  return Math.round(s.length * size * 0.6);
}

/**
 * Lay the hook out word by word, with an ABSOLUTE x for each word.
 *
 * The subtle way to get this wrong — and the way it WAS wrong first — is to give every word
 * `x=(w-text_w)/2`. drawtext centres each draw independently, so all the words land on top of
 * each other in the middle of the frame and the hook renders as an unreadable smear. ffmpeg
 * cannot be asked how wide the previous words were, so the layout is computed here and handed
 * over as fixed pixel positions.
 */
export function layoutWords(
  text: string,
  size: number,
  start: number,
  opts: { gap?: number; maxWidth?: number } = {},
): { word: string; x: number; line: number; at: number }[] {
  const gap = opts.gap ?? 0.1;
  const maxWidth = opts.maxWidth ?? W - 150;
  const space = Math.round(size * 0.32);
  const words = text.trim().split(/\s+/).filter(Boolean);

  const lines: string[][] = [[]];
  let width = 0;
  for (const wd of words) {
    const ww = textWidth(wd, size);
    const add = lines[lines.length - 1].length ? space + ww : ww;
    if (width + add > maxWidth && lines[lines.length - 1].length) {
      lines.push([wd]);
      width = ww;
    } else {
      lines[lines.length - 1].push(wd);
      width += add;
    }
  }

  const out: { word: string; x: number; line: number; at: number }[] = [];
  let n = 0;
  lines.forEach((ln, li) => {
    const total = ln.reduce((acc, wd, i) => acc + textWidth(wd, size) + (i ? space : 0), 0);
    let x = Math.round((W - total) / 2);
    for (const wd of ln) {
      out.push({ word: wd, x, line: li, at: Number((start + n * gap).toFixed(2)) });
      x += textWidth(wd, size) + space;
      n++;
    }
  });
  return out;
}

// ── the graph ─────────────────────────────────────────────────────────────

export interface ComposeOptions {
  /** Absolute-ish path usable inside a filtergraph (relative, forward slashes). */
  fontFile: string;
  /** Per-line text files already written to disk, `lines[m][i]`. */
  lineFiles: string[][];
  /** Font size per message. */
  sizes: number[];
  /** Hook words as separate files, for the word-by-word reveal. */
  hookWordFiles: { file: string; at: number; x: number; line: number }[];
  zone: ProductZone;
  navy: string;
  gold: string;
  /** Input indices. */
  idx: { clip: number; music: number; logo: number; gradient: number };
  brandUrl?: string;
}

/**
 * Build the whole video filtergraph.
 *
 * Pure: takes paths and numbers, returns a string. That is what makes the layout testable —
 * the geometry and the timing are the parts that regress, and neither needs ffmpeg to check.
 */
export function buildAdGraph(o: ComposeOptions): string {
  const band = textBand(o.zone);
  const g = gradientRect(o.zone);
  const barY = H - BAR_H;
  const plateH = 88, plateW = 340;
  const plateY = barY + Math.round((BAR_H - plateH) / 2);
  const urlY = barY + Math.round((BAR_H - 46) / 2) - 4;
  const frames = DURATION * FPS;

  const parts: string[] = [];

  // 1. TWO-STAGE PUSH-IN, and the split is the whole point.
  //
  //    A single linear zoom across 15 s measured almost nothing in the first two seconds —
  //    0.12 spread over 450 frames is invisible per frame, and inter-frame difference over
  //    a 1 s slice barely moved. But the first two seconds are the only ones that decide
  //    whether the ad is watched at all.
  //
  //    So the motion is front-loaded: a fast PUNCH of 0.07 over the first 1.2 s, where a
  //    thumb is deciding, then a slow drift of another 0.06 across the rest so the frame
  //    never goes static. Same end scale, motion moved to where it is worth something.
  const punchFrames = Math.round(1.2 * FPS);
  parts.push(
    `[${o.idx.clip}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `zoompan=z='min(1+0.07*min(on/${punchFrames},1)+0.06*(on/${frames}),1.13)':d=1:` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `s=${W}x${H}:fps=${FPS},setsar=1[push]`,
  );

  // 2. Soft gradient instead of a slab: only the text band darkens, and it falls off, so the
  //    product keeps its own contrast.
  parts.push(`[${o.idx.gradient}:v]format=rgba[grad]`);
  parts.push(`[push][grad]overlay=0:${g.y}[scrimmed]`);

  // 3. Brand bar + logo plate + URL (kept as-is).
  parts.push(`[scrimmed]drawbox=x=0:y=${barY}:w=${W}:h=${BAR_H}:color=${o.navy}@0.72:t=fill[bar]`);
  parts.push(`[${o.idx.logo}:v]scale=300:-1[logo_s]`);
  parts.push(`color=white@0.92:size=${plateW}x${plateH}:r=${FPS}[plate]`);
  parts.push(`[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[lb]`);
  parts.push(`[bar][lb]overlay=44:${plateY}[wl]`);
  parts.push(
    `[wl]drawtext=fontfile=${o.fontFile}:text=${o.brandUrl ?? "ameublodirect.ca"}:fontcolor=${o.gold}:` +
      `fontsize=46:borderw=1:bordercolor=black@0.4:x=W-text_w-56:y=${urlY}[branded]`,
  );

  // 4. One-frame white flash at each message change. A hard punctuation mark: it costs one
  //    frame, survives compression, and is what makes a cut feel deliberate rather than
  //    accidental on a feed.
  const flashes = WINDOWS.slice(1)
    .map(([s]) => `drawbox=x=0:y=0:w=${W}:h=${H}:color=white@0.55:t=fill:enable='${between(s, s + 0.04)}'`)
    .join(",");
  parts.push(`[branded]${flashes}[flashed]`);

  // 5. Copy.
  const draws: string[] = [];
  const common = `fontfile=${o.fontFile}:fontcolor=white:borderw=3:bordercolor=black@0.55:shadowcolor=black@0.6:shadowx=2:shadowy=2`;

  o.lineFiles.forEach((lines, m) => {
    const [s0, e0] = WINDOWS[m];
    const size = o.sizes[m];
    const gap = Math.round(size * 1.28);
    const top = band.y + Math.round((band.height - lines.length * gap) / 2);

    if (m === 0) {
      // Hook: word by word. Each word is its own draw, appearing 0.1 s after the last, so the
      // headline assembles itself in front of the viewer. Motion that cannot be missed, and it
      // buys attention across the exact window a scroll decision happens in.
      o.hookWordFiles.forEach(({ file, at, x, line }) => {
        draws.push(
          `drawtext=${common}:textfile=${file}:fontsize=${size}:` +
            `x=${x}:y=${top + line * gap}:` +
            `alpha='${prog(at, 0.12)}':enable='${between(s0, e0)}'`,
        );
      });
    } else {
      lines.forEach((file, i) => {
        const y = top + i * gap;
        let motion: string;
        if (m === 1) {
          // Benefit: slides up 140 px in 0.25 s. Shorter and further than v2's 220 px over
          // 0.4 s eased, which spent most of its time already in place.
          motion = `x=(w-text_w)/2:y='${y}+(1-${easeOut(s0, 0.25)})*140':alpha='${prog(s0, 0.2)}'`;
        } else if (m === 2) {
          // Price: the "pop", as three constant-size draws (see the header — an expression
          // fontsize segfaults). Handled below; this branch only positions the final size.
          motion = `x=(w-text_w)/2:y=${y}:alpha='${prog(s0, 0.2)}'`;
        } else {
          motion = `x='(w-text_w)/2+(1-${easeOut(s0, 0.25)})*${W}':y=${y}:alpha='${prog(s0, 0.2)}'`;
        }
        if (m === 2) {
          const STEPS = [0.82, 0.93, 1];
          const stepDur = 0.24 / STEPS.length;
          STEPS.forEach((k, si) => {
            const a = s0 + si * stepDur;
            const b = si === STEPS.length - 1 ? e0 : s0 + (si + 1) * stepDur;
            draws.push(
              `drawtext=${common}:textfile=${file}:fontsize=${Math.max(8, Math.round(size * k))}:` +
                `x=(w-text_w)/2:y='${Math.round(y + gap / 2)}-text_h/2':alpha='${prog(s0, 0.18)}':` +
                `enable='${between(a, b)}'`,
            );
          });
        } else {
          draws.push(`drawtext=${common}:textfile=${file}:fontsize=${size}:${motion}:enable='${between(s0, e0)}'`);
        }
      });
    }

    // 6. Gold keyline that WIPES OPEN under each message. A solid shape growing is far more
    //    visible in a feed than text changing opacity, and it gives every message the same
    //    beat without adding another word to read.
    const lineY = top + lines.length * gap + 18;
    draws.push(
      `drawbox=x='(${W}-460*${prog(s0, 0.35)})/2':y=${lineY}:w='460*${prog(s0, 0.35)}':h=6:` +
        `color=${o.gold}:t=fill:enable='${between(s0, e0)}'`,
    );
  });

  parts.push(
    `[flashed]${draws.join(",")},fade=t=out:st=${(DURATION - 0.4).toFixed(2)}:d=0.4,` +
      `setsar=1,format=yuv420p[vout]`,
  );
  return parts.join(";");
}

/** Audio chain: the picked bed, tempo-shifted, ducked and faded. */
export function buildAudioGraph(idx: number, music: MusicChoice): string {
  // 0.22 is the level the v3 creative was approved at; the per-track gain only brings the
  // rest of the pool up to the two original beds rather than re-tuning the mix.
  const vol = Number((0.22 * (music.gain ?? 1)).toFixed(3));
  return (
    `[${idx}:a]atempo=${music.tempo},volume=${vol},` +
    `afade=t=in:d=0.8,afade=t=out:st=${(DURATION - 1).toFixed(2)}:d=1[aout]`
  );
}
