/**
 * Ameublo, the store mascot, as a parametric SVG — the free animation route ("option A").
 *
 * WHY A PARAMETRIC SVG AND NOT GENERATED IMAGES
 * The character is our own vector drawing (docs/brand/ameublo-mascot.svg). Building every
 * frame from the same shapes keeps him exactly on-model in every video, costs nothing per
 * render, and needs no AI call: a pose is a handful of numbers (arm angle, eyes, mouth…).
 *
 * `ameubloSvg(pose)` draws one frame; `ameubloPoseAt(t, …)` is the "Ameublo présente"
 * choreography (enter, wave, present the product, wave goodbye). The video side
 * (rasterising frames, ffmpeg overlay) lives in video-engines/ameublo-overlay.ts.
 */

export type AmeubloEyes = "open" | "happy" | "closed";
export type AmeubloMouth = "smile" | "o" | "laugh";
export type AmeubloAccessory = "none" | "tuque" | "santa" | "leaf" | "witch";

export interface AmeubloPose {
  eyes: AmeubloEyes;
  mouth: AmeubloMouth;
  /** Pupil offset in drawing units (≈ ±2): where he looks. */
  look: { dx: number; dy: number };
  /** Right armrest (the "arm"): 0 = resting, 1 = raised 16 units. */
  armLift: number;
  /** Right arm rotation in degrees around its base; positive tilts it outward (wave). */
  armAngle: number;
  /** Left armrest, same convention mirrored: lift 0-1, negative angle tilts it outward (to our left). */
  leftArmLift: number;
  leftArmAngle: number;
  /** Whole-body vertical offset in drawing units (negative = up: hops, entrance). */
  bodyY: number;
  /** Breathing / landing squash: 1 = neutral, < 1 = squashed. */
  squash: number;
  accessory: AmeubloAccessory;
}

export const NEUTRAL_POSE: AmeubloPose = {
  eyes: "open",
  mouth: "smile",
  look: { dx: 0, dy: 0 },
  armLift: 0,
  armAngle: 0,
  leftArmLift: 0,
  leftArmAngle: 0,
  bodyY: 0,
  squash: 1,
  accessory: "none",
};

/**
 * Drawing canvas. The original 120×120 viewBox is widened so a raised arm, a hop and a hat
 * never clip: the character sits at the same coordinates, the frame just has headroom.
 */
export const VIEWBOX = { x: -25, y: -45, w: 170, h: 170 } as const;

const C = {
  gold: "#D4A853",
  goldLight: "#E2BC6E",
  goldDeep: "#C99A43",
  cream: "#FBF3E2",
  seam: "#EADCC0",
  wood: "#8a5a2b",
  navy: "#1b2a47",
  cheek: "#E9897E",
  button: "#C17F3E",
};

const r = (n: number) => Math.round(n * 100) / 100;

function eyesSvg(pose: AmeubloPose): string {
  if (pose.eyes === "happy") {
    return `<g fill="none" stroke="${C.navy}" stroke-width="3" stroke-linecap="round">` +
      `<path d="M45 49 Q50 43 55 49"/><path d="M65 49 Q70 43 75 49"/></g>`;
  }
  if (pose.eyes === "closed") {
    return `<g fill="none" stroke="${C.navy}" stroke-width="2.6" stroke-linecap="round">` +
      `<path d="M45 48 H55"/><path d="M65 48 H75"/></g>`;
  }
  const dx = r(pose.look.dx);
  const dy = r(pose.look.dy);
  const eye = (cx: number) =>
    `<ellipse cx="${cx}" cy="48" rx="5" ry="6.4" fill="${C.navy}"/>` +
    `<circle cx="${r(cx + 1.6 + dx)}" cy="${r(45.8 + dy)}" r="1.8" fill="#fff"/>`;
  return eye(50) + eye(70);
}

function mouthSvg(m: AmeubloMouth): string {
  if (m === "o") return `<ellipse cx="60" cy="59" rx="2.6" ry="3" fill="${C.navy}"/>`;
  if (m === "laugh") {
    return `<path d="M52 56 Q60 68 68 56 Z" fill="${C.navy}"/>` +
      `<path d="M56 61.5 Q60 65 64 61.5 Q60 60 56 61.5 Z" fill="${C.cheek}"/>`;
  }
  return `<path d="M53 57 Q60 64 67 57" fill="none" stroke="${C.navy}" stroke-width="2.6" stroke-linecap="round"/>`;
}

/** Seasonal accessory, drawn on top of the backrest (top of the backrest is y≈18). */
export function accessorySvg(a: AmeubloAccessory): string {
  switch (a) {
    case "tuque": // Quebec winter tuque: red knit, cream band with red stitches, pompom.
      return `<path d="M31 28 C31 4 89 4 89 28 Z" fill="#C8312F"/>` +
        `<rect x="27" y="22" width="66" height="11" rx="5.5" fill="#F4EDE4"/>` +
        `<path d="M33 27.5 H87" stroke="#C8312F" stroke-width="2" stroke-dasharray="3 3"/>` +
        `<circle cx="60" cy="1" r="7" fill="#F4EDE4"/>`;
    case "santa":
      return `<path d="M31 27 Q44 -6 96 -2 Q86 8 89 27 Z" fill="#C8312F"/>` +
        `<rect x="27" y="21" width="66" height="11" rx="5.5" fill="#fff"/>` +
        `<circle cx="98" cy="-2" r="6.5" fill="#fff"/>`;
    case "leaf": // a maple leaf tucked at the corner of the backrest
      return `<g transform="translate(84 6) rotate(18) scale(0.95)" fill="#D9622B">` +
        `<path d="M0 -14 L3 -6 L9 -9 L7 -2 L14 -3 L9 3 L11 5 L3 5 L1 12 L-1 12 L-3 5 L-11 5 L-9 3 L-14 -3 L-7 -2 L-9 -9 L-3 -6 Z"/>` +
        `<path d="M0 6 L0 16" stroke="#A8461C" stroke-width="1.6" stroke-linecap="round"/></g>`;
    case "witch":
      return `<ellipse cx="60" cy="24" rx="36" ry="5.5" fill="#2B1E3F"/>` +
        `<path d="M43 23 L57 -20 Q62 -26 64 -16 L77 23 Z" fill="#2B1E3F"/>` +
        `<rect x="45" y="15" width="31" height="6" fill="#E07B24"/>`;
    default:
      return "";
  }
}

/** One frame of Ameublo as a standalone SVG document, `size` pixels square. */
export function ameubloSvg(pose: AmeubloPose, size = 360, opts: { shadow?: boolean } = {}): string {
  const { x, y, w, h } = VIEWBOX;
  // Squash keeps the feet planted: scale around the floor line (y = 110).
  const sq = r(pose.squash);
  const stretch = r(1 + (1 - pose.squash) * 0.6);
  const body = `translate(0 ${r(pose.bodyY)}) translate(60 110) scale(${stretch} ${sq}) translate(-60 -110)`;
  // Arm pivots on its base (98, 94), like the CSS rig's transform-origin 50% 100%.
  const arm = `translate(0 ${r(-16 * pose.armLift)}) rotate(${r(pose.armAngle)} 98 94)`;
  const leftArm = `translate(0 ${r(-16 * pose.leftArmLift)}) rotate(${r(pose.leftArmAngle)} 22 94)`;
  // The floor shadow shrinks as he leaves the ground.
  const shadowScale = r(Math.max(0.55, 1 + pose.bodyY / 40));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${size}" height="${size}">` +
    (opts.shadow === false ? "" : `<ellipse cx="60" cy="112" rx="${r(34 * shadowScale)}" ry="4.5" fill="${C.navy}" opacity=".12"/>`) +
    `<g transform="${body}">` +
      `<rect x="31" y="96" width="7" height="14" rx="3" fill="${C.wood}"/>` +
      `<rect x="82" y="96" width="7" height="14" rx="3" fill="${C.wood}"/>` +
      `<path d="M24 70 C22 34 38 18 60 18 C82 18 98 34 96 70 Z" fill="${C.gold}"/>` +
      `<path d="M30 66 C30 38 42 26 60 26 C78 26 90 38 90 66 Z" fill="${C.goldLight}"/>` +
      `<circle cx="46" cy="36" r="1.6" fill="${C.button}"/><circle cx="74" cy="36" r="1.6" fill="${C.button}"/>` +
      eyesSvg(pose) +
      `<ellipse cx="42" cy="57" rx="4.2" ry="2.6" fill="${C.cheek}" opacity=".55"/>` +
      `<ellipse cx="78" cy="57" rx="4.2" ry="2.6" fill="${C.cheek}" opacity=".55"/>` +
      mouthSvg(pose.mouth) +
      `<rect x="22" y="70" width="76" height="28" rx="10" fill="${C.goldDeep}"/>` +
      `<rect x="30" y="66" width="60" height="16" rx="8" fill="${C.cream}"/>` +
      `<path d="M36 74 H84" stroke="${C.seam}" stroke-width="2" stroke-linecap="round"/>` +
      `<g transform="${leftArm}">` +
        `<rect x="12" y="58" width="20" height="36" rx="10" fill="${C.gold}"/>` +
        `<rect x="12" y="58" width="20" height="10" rx="5" fill="${C.goldLight}"/>` +
      `</g>` +
      `<g transform="${arm}">` +
        `<rect x="88" y="58" width="20" height="36" rx="10" fill="${C.gold}"/>` +
        `<rect x="88" y="58" width="20" height="10" rx="5" fill="${C.goldLight}"/>` +
      `</g>` +
      accessorySvg(pose.accessory) +
    `</g></svg>`;
}

// ── "Ameublo présente" choreography ─────────────────────────────────────────

export interface Choreography {
  /** Total clip length in seconds. */
  duration: number;
  /** When the speech bubble is up (he points at it meanwhile). */
  bubble: { start: number; end: number };
  /** Side the bubble is on, from the viewer's point of view: he points with the arm on that side. */
  pointSide: "left" | "right";
  accessory: AmeubloAccessory;
}

/** Bubble timing for a clip: after the hello wave, until just before the goodbye. */
export function defaultChoreography(
  duration: number,
  accessory: AmeubloAccessory = "none",
  pointSide: "left" | "right" = "left",
): Choreography {
  const start = Math.min(2.2, duration * 0.25);
  const end = Math.max(start + 1.5, duration - 2.0);
  return { duration, bubble: { start, end: Math.min(end, duration) }, pointSide, accessory };
}

const ENTER = 0.5; // seconds to pop up into frame
const HELLO = 1.4; // hello wave after the entrance
const BYE = 1.6; // goodbye wave at the end

const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Waving arm at time `local` seconds into a wave. */
function wave(local: number): Pick<AmeubloPose, "armLift" | "armAngle"> {
  const lift = clamp01(local / 0.15);
  return { armLift: lift, armAngle: 8 + 14 * Math.sin(local * 2 * Math.PI * 1.6) };
}

/** Ameublo's pose `t` seconds into a clip. Pure: the same t always gives the same frame. */
export function ameubloPoseAt(t: number, ch: Choreography): AmeubloPose {
  const pose: AmeubloPose = { ...NEUTRAL_POSE, look: { dx: 0, dy: 0 }, accessory: ch.accessory };

  // Breathing, always on.
  pose.squash = 1 - 0.015 * Math.sin((t * 2 * Math.PI) / 3.6);

  // Entrance: rise from below the frame with a little overshoot, then land with a squash.
  if (t < ENTER) {
    pose.bodyY = (1 - easeOutBack(clamp01(t / ENTER))) * 120;
    pose.eyes = "happy";
  } else if (t < ENTER + 0.18) {
    pose.squash = 1 - 0.06 * Math.sin(((t - ENTER) / 0.18) * Math.PI);
  }

  const byeStart = ch.duration - BYE;
  if (t >= ENTER && t < ENTER + HELLO && t < ch.bubble.start) {
    Object.assign(pose, wave(t - ENTER));
    pose.eyes = "happy";
    pose.mouth = "laugh";
  } else if (t >= ch.bubble.start && t < ch.bubble.end) {
    // Presenting: the arm on the bubble's side goes up and out toward it, eyes on it.
    const k = clamp01((t - ch.bubble.start) / 0.2);
    const dir = ch.pointSide === "left" ? -1 : 1;
    if (dir < 0) { pose.leftArmLift = k; pose.leftArmAngle = -35 * k; }
    else { pose.armLift = k; pose.armAngle = 35 * k; }
    pose.look = { dx: 2 * dir * k, dy: -1.5 * k };
    pose.mouth = t - ch.bubble.start < 0.35 ? "o" : "smile";
  } else if (t >= byeStart) {
    const local = t - byeStart;
    Object.assign(pose, wave(local));
    pose.eyes = "happy";
    pose.mouth = "laugh";
    // Two little hops.
    pose.bodyY = -7 * Math.abs(Math.sin(local * Math.PI * 2.5)) * (local < 0.8 ? 1 : 0);
  }

  // Blink every ~3.2 s (open eyes only), never during the entrance.
  if (pose.eyes === "open" && t > ENTER && (t % 3.2) < 0.12) pose.eyes = "closed";
  return pose;
}

/** Campaign → seasonal accessory. Unknown campaigns get none rather than a wrong hat. */
export function accessoryForCampaign(campaign: string): AmeubloAccessory {
  if (/^halloween/.test(campaign)) return "witch";
  if (/^(noel|hiver)/.test(campaign)) return campaign.startsWith("noel") ? "santa" : "tuque";
  if (/^automne/.test(campaign)) return "leaf";
  return "none";
}

/** Short in-character lines for the bubble, picked deterministically per SKU. */
export const BUBBLE_LINES_FR = [
  "MON COUP DE CŒUR",
  "APPROUVÉ PAR AMEUBLO",
  "JE L’ADORE",
  "BON CHOIX",
  "REGARDEZ-MOI ÇA",
] as const;

export function bubbleLineFor(sku: string): string {
  let h = 0;
  for (const ch of sku) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BUBBLE_LINES_FR[h % BUBBLE_LINES_FR.length];
}
