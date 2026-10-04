/**
 * "Ameublo se présente" — one informative intro video (who he is, what he does, where to find him)
 * for the pinned post of the Facebook page. Free: sharp + ffmpeg, no AI call.
 *
 *   node-x64 --env-file=../aosom-sync/.env.local tsx scripts/ameublo-intro.mts --out DIR [--lang fr|en] [--short] [--stills] [--upload]
 *
 * --stills = layout check only (contact sheet, no video). SEQ_ASSETS_ROOT = the main clone (music).
 */
import fs from "node:fs";
import path from "node:path";
import type { OverlayOptions } from "sharp";
import type { AmeubloPose } from "@/lib/ameublo-sprite";
import * as scenes from "@/lib/video-engines/ameublo-scenes";

const spriteMod = (await import("@/lib/ameublo-sprite")) as typeof import("@/lib/ameublo-sprite");
const { NEUTRAL_POSE } = (spriteMod as { default?: typeof spriteMod }).default ?? spriteMod;
const mod = scenes as typeof scenes & { default?: typeof scenes };
const { W, H, prog, easeOut, easeOutBack, textLayer, bubbleLayer, ameubloLayer, priceTagLayer, renderScene } = mod.default ?? mod;

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const LANG = opt("--lang", "fr") as "fr" | "en";
const OUT = path.resolve(opt("--out", "."));
const ROOT = process.env.SEQ_ASSETS_ROOT || path.resolve("../aosom-sync");
const FFMPEG =
  process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const MUSIC = path.join(ROOT, "src/audio/pick59-sunny-beat.mp3");

const NAVY = "#1B2A47";
const GOLD = "#D4A853";
const CREAM = "#FBF3E2";

const T = {
  fr: {
    name: "AMEUBLO",
    brand: "AMEUBLO DIRECT",
    tagline: "BOUTIQUE EN LIGNE · QUÉBEC",
    hi: ["SALUT !", "JE SUIS AMEUBLO"],
    role: ["L’ASSISTANT VIRTUEL", "DE LA BOUTIQUE"],
    whatHeader: "CE QUE JE FAIS",
    cards: [
      ["JE TROUVE TON MEUBLE", "salon, chambre, bureau, terrasse"],
      ["JE COMPLÈTE TA PIÈCE", "un tapis ? une table d’appoint ?"],
      ["JE RÉPONDS À TES QUESTIONS", "livraison, retours, garantie"],
      ["JE T’AIDE À CHOISIR", "dimensions, matériaux, déco"],
    ],
    whereHeader: "OÙ ME TROUVER ?",
    site: "AMEUBLODIRECT.CA",
    ship: "LIVRAISON GRATUITE PARTOUT AU CANADA",
    lookFor: "CHERCHE CE BOUTON SUR LE SITE",
    button: "Demandez à Ameublo",
    bye: ["À TOUT DE SUITE !"],
  },
  en: {
    name: "FURNI",
    brand: "FURNISH DIRECT",
    tagline: "ONLINE STORE · CANADA",
    hi: ["HI THERE!", "I’M FURNI"],
    role: ["THE STORE’S", "VIRTUAL ASSISTANT"],
    whatHeader: "WHAT I DO",
    cards: [
      ["I FIND YOUR FURNITURE", "living room, bedroom, office, patio"],
      ["I COMPLETE YOUR ROOM", "a rug? a side table?"],
      ["I ANSWER YOUR QUESTIONS", "delivery, returns, warranty"],
      ["I HELP YOU CHOOSE", "sizes, materials, decor ideas"],
    ],
    whereHeader: "WHERE TO FIND ME",
    site: "FURNISHDIRECT.CA",
    ship: "FREE SHIPPING ACROSS CANADA",
    lookFor: "LOOK FOR THIS BUTTON ON THE SITE",
    button: "Ask Furni",
    bye: ["SEE YOU SOON!"],
  },
}[LANG];

const SHORT = flag("--short");
// Full cut = 29 s; --short = punchy 14 s cut (same scenes, tighter beats).
const TM = SHORT
  ? { dur: 14, b: 3.6, c: 9.6, cards: [3.9, 5.2, 6.5, 7.8], cardAnim: 0.3, hi: [0.3, 1.9], role: [2.0, 3.5], waveEnd: 2.0, lookFor: 0.8, btn: 1.3, bye: 12.6 }
  : { dur: 29, b: 7.5, c: 21.5, cards: [8.1, 11.3, 14.5, 17.7], cardAnim: 0.45, hi: [0.5, 3.5], role: [3.7, 7.2], waveEnd: 3.6, lookFor: 1.6, btn: 2.2, bye: 26.0 };
const DURATION = TM.dur;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const pose = (p: Partial<AmeubloPose>, t: number): AmeubloPose => ({
  ...NEUTRAL_POSE,
  look: { dx: 0, dy: 0 },
  squash: 1 - 0.015 * Math.sin((t * 2 * Math.PI) / 3.6),
  ...p,
});
const entrance = (t: number, at = 0, d = 0.5) => (1 - easeOutBack(prog(t, at, d))) * 120;
const waving = (t: number) => ({ armLift: 1, armAngle: 8 + 14 * Math.sin(t * 2 * Math.PI * 1.6) });
const hop = (t: number, rate = 2.5, height = 8) => -height * Math.abs(Math.sin(t * Math.PI * rate));
const blink = (t: number) => t % 3.2 < 0.12;

const B_START = TM.b;
const C_START = TM.c;
const CARD_AT = TM.cards;
const CARD_H = 200;
const CARD_PITCH = 224;
const CARD_TOP = 270;

async function background(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${NAVY}"/><stop offset="1" stop-color="#24365C"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`,
    ),
  ).png().toBuffer();
}

function roundRect(w: number, h: number, fill: string, stroke?: string, r = 44, opacity = 1): OverlayOptions["input"] {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="3" y="3" width="${w - 6}" height="${h - 6}" rx="${r}" fill="${fill}" opacity="${opacity}"` +
      `${stroke ? ` stroke="${stroke}" stroke-width="5"` : ""}/></svg>`,
  );
}

async function card(i: number, t: number): Promise<OverlayOptions[]> {
  const local = t - CARD_AT[i];
  if (local < 0) return [];
  const k = easeOut(prog(local, 0, TM.cardAnim));
  const left = Math.round(lerp(W, 80, k));
  const top = CARD_TOP + i * CARD_PITCH;
  const cx = left + 150 + (920 - 150) / 2;
  const out: OverlayOptions[] = [{ input: roundRect(920, CARD_H, "#ffffff", undefined, 44), left, top }];
  out.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="45" fill="${GOLD}" stroke="${NAVY}" stroke-width="5"/></svg>`), left: left + 34, top: top + 52 });
  out.push(...(await textLayer([String(i + 1)], top + 64, { size: 54, color: NAVY, cx: left + 82 })));
  out.push(...(await textLayer([T.cards[i][0]], top + 38, { size: 46, color: NAVY, cx })));
  out.push(...(await textLayer([T.cards[i][1]], top + 108, { size: 36, color: "#4A5568", weight: 400, cx })));
  return out;
}

async function buttonReplica(top: number, t: number): Promise<OverlayOptions[]> {
  const out: OverlayOptions[] = [{ input: roundRect(920, 300, CREAM, undefined, 40), left: 80, top }];
  const pillW = 600;
  const pillH = 104;
  const pl = 110;
  const pt = top + 98;
  out.push({ input: roundRect(pillW, pillH, NAVY, GOLD, 43), left: pl, top: pt });
  out.push(...(await textLayer([T.button], pt + 18, { size: 50, color: "#ffffff", cx: pl + pillW / 2 })));
  const wob = 1 + 0.04 * Math.sin(t * 5);
  out.push(ameubloLayer(pose({ eyes: "happy", mouth: "smile", bodyY: hop(t, 2.2, 5) }, t), Math.round(250 * wob), 690, top + 20));
  return out;
}

async function layersAt(t: number): Promise<OverlayOptions[]> {
  const L: OverlayOptions[] = [];
  const inA = t < B_START;
  const inB = t >= B_START && t < C_START;
  const inC = t >= C_START;

  // Headers
  if (inA) {
    L.push(...(await textLayer([T.brand], 150, { size: 72, color: GOLD, opacity: easeOut(prog(t, 0, 0.5)) })));
    L.push(...(await textLayer([T.tagline], 245, { size: 38, color: "#ffffff", opacity: easeOut(prog(t, 0.3, 0.5)) })));
  } else if (inB) {
    L.push(...(await textLayer([T.whatHeader], 150, { size: 72, color: GOLD, opacity: easeOut(prog(t, B_START, 0.35)) })));
  } else {
    L.push(...(await textLayer([T.whereHeader], 150, { size: 72, color: GOLD, opacity: easeOut(prog(t, C_START, 0.35)) })));
  }

  // Mascot: big in the middle for A, small bottom-left afterwards
  const toSmall = easeOut(prog(t, B_START - 0.2, 0.5));
  const size = lerp(820, 480, toSmall);
  const x = lerp((W - 820) / 2, 0, toSmall);
  const y = lerp(640, 1010, toSmall);
  let ps: AmeubloPose;
  if (t < 0.4) ps = pose({ bodyY: entrance(t, 0, 0.4), eyes: "happy" }, t);
  else if (t < TM.waveEnd) ps = pose({ ...waving(t - 0.4), eyes: "happy", mouth: "laugh", bodyY: hop(t - 0.4, 2.4, 6) }, t);
  else if (t < B_START) ps = pose({ eyes: blink(t) ? "closed" : "open", mouth: "smile", armLift: 0.4, armAngle: 12 }, t);
  else if (inB) {
    const k = prog(t, B_START + 0.3, 0.3);
    ps = pose({ armLift: k, armAngle: 30 * k, look: { dx: 2, dy: -2 }, eyes: blink(t) ? "closed" : "open", mouth: "smile" }, t);
  } else if (t < TM.bye + 0.2) ps = pose({ eyes: "wide", mouth: "laugh", armLift: 1, armAngle: 32, bodyY: hop(t - C_START, 2.5, 6) }, t);
  else ps = pose({ ...waving(t - TM.bye - 0.2), eyes: "happy", mouth: "laugh", bodyY: hop(t - TM.bye - 0.2, 2.5, 6) }, t);

  // Speech bubbles
  if (t >= TM.hi[0] && t < TM.hi[1]) L.push(...(await bubbleLayer(T.hi, 90, 400, 900, 76, 540, prog(t, TM.hi[0], 0.15) * (1 - prog(t, TM.hi[1] - 0.15, 0.15)))));
  if (t >= TM.role[0] && t < TM.role[1]) L.push(...(await bubbleLayer(T.role, 90, 400, 900, 66, 540, prog(t, TM.role[0], 0.15) * (1 - prog(t, TM.role[1] - 0.15, 0.15)))));

  if (inB || (t >= C_START - 0.3 && t < C_START)) {
    for (let i = 0; i < 4; i++) {
      const outFade = i >= 0 && t >= C_START - 0.3 ? 1 - prog(t, C_START - 0.3, 0.3) : 1;
      const cl = await card(i, t);
      if (outFade >= 1) L.push(...cl);
      else if (outFade > 0.02) {
        const sharp = (await import("sharp")).default;
        for (const c of cl) L.push({ ...c, input: await sharp(c.input as Buffer).ensureAlpha().linear([1, 1, 1, outFade], [0, 0, 0, 0]).png().toBuffer() });
      }
    }
  }

  if (inC) {
    const k = prog(t, C_START + 0.2, 0.4);
    if (k > 0) L.push(...(await priceTagLayer(T.site, 540, 270 - (1 - easeOut(k)) * 30, T.ship, 0.8, "#ffffff")));
    if (t >= C_START + TM.lookFor) {
      L.push(...(await textLayer([T.lookFor], 560, { size: 46, color: "#ffffff", opacity: easeOut(prog(t, C_START + TM.lookFor, 0.4)) })));
    }
    if (t >= C_START + TM.btn) {
      const k2 = easeOut(prog(t, C_START + TM.btn, 0.45));
      const btn = await buttonReplica(Math.round(lerp(690, 650, k2)), t);
      if (k2 >= 1) L.push(...btn);
      else {
        const sharp = (await import("sharp")).default;
        for (const c of btn) L.push({ ...c, input: await sharp(c.input as Buffer).ensureAlpha().linear([1, 1, 1, k2], [0, 0, 0, 0]).png().toBuffer() });
      }
    }
    if (t >= TM.bye) L.push(...(await bubbleLayer(T.bye, 60, 1035, 600, 60, 250, prog(t, TM.bye, 0.15))));
  }

  L.push(ameubloLayer(ps, size, x, y));
  return L;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const spec = { duration: DURATION, background: await background(), music: MUSIC, musicVolume: 0.5, layersAt };
  if (flag("--stills")) {
    const sharp = (await import("sharp")).default;
    const times = SHORT ? [0.3, 1.2, 2.8, 4.6, 5.8, 7.0, 8.8, 10.8, 12.0, 13.5] : [0.3, 2.0, 5.0, 9.5, 12.5, 15.5, 20.0, 23.0, 25.0, 27.5];
    const tiles: OverlayOptions[] = [];
    for (let i = 0; i < times.length; i++) {
      const bgFull = sharp(spec.background);
      const ls = await layersAt(times[i]);
      const full = await bgFull.composite(ls).png().toBuffer();
      const frame = await sharp(full).resize(324, 576).png().toBuffer();
      tiles.push({ input: frame, left: (i % 5) * 324, top: Math.floor(i / 5) * 576 });
    }
    const sheet = path.join(OUT, `intro${SHORT ? "-short" : ""}-${LANG}-stills.jpg`);
    await sharp({ create: { width: 324 * 5, height: 576 * 2, channels: 3, background: "#000" } }).composite(tiles).jpeg({ quality: 82 }).toFile(sheet);
    console.log("stills:", sheet);
    return;
  }
  const out = path.join(OUT, `ameublo-presentation${SHORT ? "-short" : ""}-${LANG}.mp4`);
  await renderScene(spec, out, FFMPEG);
  console.log("video:", out, (fs.statSync(out).size / 1e6).toFixed(1), "MB");
  if (flag("--upload")) {
    const { put } = await import("@vercel/blob");
    const blob = await put(`ameublo-intro/ameublo-presentation${SHORT ? "-short" : ""}-${LANG}.mp4`, fs.readFileSync(out), {
      access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
    });
    console.log("url:", blob.url);
  }
}

await main();
