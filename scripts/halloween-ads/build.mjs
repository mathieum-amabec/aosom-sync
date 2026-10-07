// Halloween bilingual ad builder — real product footage only (NO mascot). Audio is synthesized (no licensing).
// Usage: node build.mjs <variant> ; outputs out/halloween-<variant>.mp4
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";

const FF = process.env.FFMPEG_BIN || "ffmpeg"; // set FFMPEG_BIN to the ffmpeg 8+ binary (needs drawtext)
const ROOT = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join("/");
const WORK = `${ROOT}/work`;
mkdirSync(WORK, { recursive: true });
mkdirSync(`${ROOT}/out`, { recursive: true });
// Impact is a licensed Windows font: point FONT_FILE at any bold condensed TTF you may use.
if (!existsSync(`${WORK}/font.ttf`)) copyFileSync(process.env.FONT_FILE || "C:/Windows/Fonts/impact.ttf", `${WORK}/font.ttf`);
const variant = process.argv[2] || "A";

// src = file in src/, ss = start sec in source, d = duration, fr/en = overlay text, flash = cut-flash colour
const CLIPS = {
  zombie: "p-844-696V00GY.mp4", witch: "p-844-693V00BK.mp4", clown: "p-844-511V00MX.mp4",
  spider: "p-830-097.mp4", cat: "p-830-098.mp4", tree: "p-844-494V80MX.mp4",
  witches: "p-830-100.mp4", ghost: "p-830-095.mp4", cocoon: "p-844-690V00GY.mp4", clown2: "p-844-872V00GY.mp4", owl: "p-844-037.mp4", witch2: "p-844-874V00BN.mp4", reaper: "p-830-105.mp4",
};
const W = "0xffffff", R = "0xff2200";
const VARIANTS = {
  A: [
    { c: "zombie", ss: 4.0, d: 1.7, fr: "OSERAS-TU ?", en: "DARE YOU?", flash: W },
    { c: "witch", ss: 5.0, d: 1.3, fr: "DÉCO D'HALLOWEEN", en: "HALLOWEEN DECOR", flash: R },
    { c: "clown", ss: 10.0, d: 1.3, fr: "ÇA BOUGE", en: "IT MOVES", flash: W },
    { c: "spider", ss: 9.8, d: 1.3, fr: "ÇA FAIT PEUR", en: "IT SCARES", flash: R },
    { c: "cat", ss: 11.5, d: 1.3, fr: "ÇA S'ILLUMINE", en: "IT LIGHTS UP", flash: W },
    { c: "tree", ss: 22.0, d: 1.5, fr: "LIVRAISON GRATUITE", en: "FREE SHIPPING", flash: R },
    { c: "witches", ss: 21.8, d: 1.4, fr: "COMMANDE-LA MAINTENANT", en: "ORDER IT NOW", flash: W },
    { c: "witch2", ss: 30.0, d: 1.3, fr: "AVANT QU'IL SOIT TROP TARD", en: "BEFORE IT'S TOO LATE", flash: R },
    { c: "tree", ss: 15.0, d: 3.6, fr: "COMMANDE AVANT LE 23 OCTOBRE", en: "ORDER BY OCTOBER 23", cta: true, flash: W },
  ],
  B: [
    { c: "reaper", ss: 17.5, d: 1.6, fr: "ELLE ARRIVE…", en: "SHE'S COMING…", flash: W },
    { c: "witch2", ss: 33.0, d: 1.3, fr: "ÇA RESPIRE", en: "IT BREATHES", flash: R },
    { c: "zombie", ss: 8.0, d: 1.3, fr: "TON ENTRÉE", en: "YOUR FRONT YARD", flash: W },
    { c: "clown", ss: 14.0, d: 1.3, fr: "LE CLOWN T'ATTEND", en: "THE CLOWN WAITS", flash: R },
    { c: "reaper", ss: 22.0, d: 1.3, fr: "ILS SONT PARTOUT", en: "THEY'RE EVERYWHERE", flash: W },
    { c: "spider", ss: 2.0, d: 1.3, fr: "LIVRAISON GRATUITE", en: "FREE SHIPPING", flash: R },
    { c: "cat", ss: 20.8, d: 1.4, fr: "COMMANDE MAINTENANT", en: "ORDER NOW", flash: W },
    { c: "tree", ss: 8.0, d: 1.3, fr: "LE 31 APPROCHE", en: "THE 31ST IS COMING", flash: R },
    { c: "tree", ss: 24.0, d: 3.6, fr: "COMMANDE AVANT LE 23 OCTOBRE", en: "ORDER BY OCTOBER 23", cta: true, flash: W },
  ],
};

// ---- generated variants V03..V13 (seeded; only segments verified clean of source overlay text) ----
VARIANTS.V01 = VARIANTS.A; VARIANTS.V02 = VARIANTS.B;
const HOOK_SEG = [["zombie",3.5],["reaper",17.5],["witch",4.5],["clown2",20.0],["clown",20.0],["witch2",30.0],["cat",21.0],["zombie",13.5],["witch",15.5],["clown2",11.5],["spider",9.8]];
const HOOK_TXT = [["TU L'ENTENDS ?","CAN YOU HEAR IT?"],["PAS DE PANIQUE…","DON'T PANIC…"],["ILS T'ATTENDENT","THEY'RE WAITING"],["BOUH !","BOO!"],["TA MAISON EST PRÊTE ?","IS YOUR HOUSE READY?"],["LA NUIT TOMBE…","NIGHT FALLS…"],["REGARDE-LES BOUGER","WATCH THEM MOVE"],["LE 31 APPROCHE","THE 31ST IS COMING"],["ÇA COMMENCE ICI","IT STARTS HERE"],["TU OSES ?","DO YOU DARE?"],["ELLE T'A VU…","SHE SAW YOU…"]];
const BODY_SEG = [["witch",4.5],["clown",10.0],["clown",17.5],["spider",9.8],["spider",2.0],["spider",12.0],["cat",11.5],["cat",20.8],["cat",2.5],["tree",22.0],["tree",24.0],["tree",8.0],["witches",21.8],["witches",3.0],["witch2",30.0],["witch2",33.0],["reaper",17.5],["reaper",22.0],["ghost",9.0],["ghost",20.0],["owl",9.5],["owl",9.5],["cocoon",0.0],["clown2",11.5],["clown2",19.5],["zombie",3.5],["zombie",13.5],["witch",15.5]];
const BODY_TXT = [["DÉCO D'HALLOWEEN","HALLOWEEN DECOR"],["ÇA BOUGE","IT MOVES"],["ÇA FAIT PEUR","IT SCARES"],["ÇA S'ILLUMINE","IT LIGHTS UP"],["LIVRAISON GRATUITE","FREE SHIPPING"],["COMMANDE-LA MAINTENANT","ORDER IT NOW"],["POUR TON ENTRÉE","FOR YOUR FRONT YARD"],["FRISSONS GARANTIS","CHILLS GUARANTEED"],["DU GRAND SPECTACLE","BIG SHOW"],["IMPOSSIBLE À IGNORER","IMPOSSIBLE TO IGNORE"],["LES VOISINS VONT ADORER","THE NEIGHBORS WILL LOVE IT"],["LE DÉCOR QUI FAIT PEUR","THE DECOR THAT SCARES"]];
const CTA_SEG = [["tree",15.0],["tree",24.0],["owl",21.0],["ghost",18.5],["spider",10.0],["cat",21.0],["witches",3.0],["reaper",17.5],["tree",15.0],["owl",21.0],["ghost",18.5]];
function rng(seed) { let x = seed * 2654435761 % 4294967296 || 1; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; }
for (let k = 3; k <= 16; k++) {
  const r = rng(k * 97 + 13), pick = (a) => a[Math.floor(r() * a.length)];
  const hs = HOOK_SEG[(k - 3) % HOOK_SEG.length], ht = HOOK_TXT[(k - 3) % HOOK_TXT.length];
  const arr = [{ c: hs[0], ss: hs[1], d: 1.5, fr: ht[0], en: ht[1], flash: W }];
  const usedSeg = new Set([hs.join("@")]); let prev = hs[0]; const txt = [...BODY_TXT].sort(() => r() - 0.5);
  while (arr.length < 8) {
    const sg = pick(BODY_SEG);
    if (usedSeg.has(sg.join("@")) || sg[0] === prev) continue;
    usedSeg.add(sg.join("@")); prev = sg[0];
    const tx = txt[arr.length - 1];
    arr.push({ c: sg[0], ss: sg[1], d: 1.3, fr: tx[0], en: tx[1], flash: arr.length % 2 ? R : W });
  }
  const cs = CTA_SEG[(k - 3) % CTA_SEG.length];
  arr.push({ c: cs[0], ss: cs[1], d: 3.6, fr: "COMMANDE AVANT LE 23 OCTOBRE", en: "ORDER BY OCTOBER 23", cta: true, flash: W });
  VARIANTS["V" + String(k).padStart(2, "0")] = arr;
}
// last-days hooks / CTA for the 21-23 Oct slots
const LAST = { 14: ["PLUS QUE 2 JOURS", "ONLY 2 DAYS LEFT"], 15: ["DEMAIN, C'EST FINI", "TOMORROW IT'S OVER"], 16: ["DERNIER JOUR", "LAST DAY"] };
for (const k of [14, 15, 16]) {
  const a = VARIANTS["V" + k]; a[0].fr = LAST[k][0]; a[0].en = LAST[k][1];
  if (k === 16) { a[a.length - 1].fr = "COMMANDE\nAUJOURD'HUI"; a[a.length - 1].en = "ORDER TODAY"; }
}
const K = /^V(d+)$/.test(variant) ? parseInt(variant.slice(1), 10) : 0;
const shots = VARIANTS[variant];
function fit(t, base, k = 0.55) { return Math.min(base, Math.floor(1000 / (t.length * k))); }
const FPS = 30;
const total = shots.reduce((s, x) => s + x.d, 0);

// ---- text files (UTF-8, avoids drawtext escaping) ----
shots.forEach((s, i) => {
  writeFileSync(`${WORK}/${variant}-fr-${i}.txt`, s.cta ? s.fr.replace("AVANT LE ", "AVANT LE\n") : s.fr, "utf8");
  writeFileSync(`${WORK}/${variant}-en-${i}.txt`, s.en, "utf8");
});
writeFileSync(`${WORK}/brand.txt`, "AMEUBLO DIRECT", "utf8");
writeFileSync(`${WORK}/strip.txt`, "AMEUBLO DIRECT  •  ameublodirect.ca", "utf8");
writeFileSync(`${WORK}/disc-fr.txt`, "Certaines conditions s'appliquent selon votre localisation", "utf8");
writeFileSync(`${WORK}/disc-en.txt`, "Some conditions apply depending on your location", "utf8");
writeFileSync(`${WORK}/url.txt`, "ameublodirect.ca", "utf8");

// ---- video graph ----
const inputs = [];
let fc = [];
shots.forEach((s, i) => {
  inputs.push("-i", `${ROOT}/src/${CLIPS[s.c]}`);
  const frames = Math.round(s.d * FPS);
  fc.push(
    `[${i}:v]trim=start=${s.ss}:duration=${s.d + 0.2},setpts=PTS-STARTPTS,fps=${FPS},split=2[a${i}][b${i}]`,
    `[a${i}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:5,eq=brightness=-0.3:saturation=1.3[bg${i}]`,
    `[b${i}]scale=2220:1250:flags=lanczos,crop=1080:1250:(iw-1080)/2:0,eq=contrast=1.18:saturation=1.3,unsharp=5:5:0.9,` +
      `zoompan=z='1+0.0012*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1250:fps=${FPS}[fg${i}]`,
    `[bg${i}][fg${i}]overlay=0:370:shortest=1,trim=end_frame=${frames},` +
      `fade=t=in:st=0:d=0.17:color=${s.flash},` + (s.cta ? `drawbox=x=0:y=1300:w=1080:h=430:color=black@0.6:t=fill,` : ``) +
      `drawtext=fontfile=font.ttf:textfile=${variant}-fr-${i}.txt:fontsize=${s.cta ? 96 : fit(s.fr, 118)}:line_spacing=4:fontcolor=0xff6a00:borderw=7:bordercolor=black:shadowx=4:shadowy=4:x=(w-text_w)/2:y=${s.cta ? 1330 : 120},` +
      `drawtext=fontfile=font.ttf:textfile=${variant}-en-${i}.txt:fontsize=${s.cta ? 66 : fit(s.en, 84, 0.5)}:fontcolor=white:borderw=6:bordercolor=black:shadowx=3:shadowy=3:x=(w-text_w)/2:y=${s.cta ? 1555 : 250}` +
      (s.cta ? `,drawtext=fontfile=font.ttf:textfile=brand.txt:fontsize=84:fontcolor=white:borderw=6:bordercolor=black:x=(w-text_w)/2:y=110,drawtext=fontfile=font.ttf:textfile=url.txt:fontsize=72:fontcolor=0xff6a00:borderw=6:bordercolor=black:x=(w-text_w)/2:y=225,drawtext=fontfile=font.ttf:textfile=disc-fr.txt:fontsize=34:fontcolor=white@0.95:borderw=3:bordercolor=black:x=(w-text_w)/2:y=1650,drawtext=fontfile=font.ttf:textfile=disc-en.txt:fontsize=34:fontcolor=white@0.95:borderw=3:bordercolor=black:x=(w-text_w)/2:y=1694` : `,drawtext=fontfile=font.ttf:textfile=strip.txt:fontsize=56:fontcolor=white@0.9:borderw=4:bordercolor=black:x=(w-text_w)/2:y=1740`) +
      `,setsar=1,format=yuv420p[v${i}]`
  );
});
fc.push(
  shots.map((_, i) => `[v${i}]`).join("") + `concat=n=${shots.length}:v=1:a=0[cat]`,
  // grade: grain, vignette, short glitch bursts at some cuts
  `[cat]noise=alls=6:allf=t,vignette=PI/4.5,` + glitchChain(shots) + `[vout]`
);

function cutTimes(sh) { const t = []; let acc = 0; sh.forEach((s) => { t.push(acc); acc += s.d; }); return t; }
function glitchChain(sh) {
  const ts = cutTimes(sh).slice(1);
  const en = ts.map((t) => `between(t,${t.toFixed(2)},${(t + 0.12).toFixed(2)})`).join("+");
  return `rgbashift=rh=14:bh=-14:gv=6:enable='${en}'`;
}

// ---- synthesized horror audio ----
const cuts = cutTimes(shots);
const a = [];
const n = cuts.length;
// drone: detuned low sines + slow tremolo, whole length
a.push(`sine=f=${50 + (K % 7)}:d=${total}[d1]`, `sine=f=${53.3 + (K % 7)}:d=${total}[d2]`, `sine=f=${100.7 + 2 * (K % 7)}:d=${total}[d3]`,
  `[d1][d2][d3]amix=inputs=3:normalize=0,tremolo=f=0.35:d=0.5,lowpass=f=220,volume=0.9[drone]`);
// hit sample (sub thump + noise burst), cloned at each cut
a.push(`sine=f=${42 + (K % 5) * 2}:d=0.6,afade=t=out:st=0:d=0.6,volume=2.2[hs]`,
  `anoisesrc=d=0.35:c=white:a=0.8,highpass=f=1200,afade=t=out:st=0:d=0.35[hn]`,
  `[hs][hn]amix=inputs=2:normalize=0,asplit=${n}${cuts.map((_, i) => `[h${i}]`).join("")}`);
cuts.forEach((t, i) => a.push(`[h${i}]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[hd${i}]`));
// shrill chirp stabs (scare) on shots 1,3 (index) + final
const stabs = [cuts[1], cuts[3], cuts[5]];
stabs.forEach((t, i) => a.push(
  `aevalsrc='0.35*sin(2*PI*(700*t+1400*t*t))*exp(-3*t)':d=0.7:s=44100,aecho=0.8:0.6:120:0.4,adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[st${i}]`));
// heartbeat (thump-thump every 0.9s)
a.push(`sine=f=62:d=0.18,afade=t=out:st=0:d=0.18,volume=1.6,asplit=2[hb1][hb2]`);
const hbTimes = []; for (let t = 0.2; t < total - 4; t += 0.8 + 0.02 * (K % 9)) hbTimes.push(t);
a.push(`[hb1]asplit=${hbTimes.length}${hbTimes.map((_, i) => `[hbA${i}]`).join("")}`);
hbTimes.forEach((t, i) => a.push(`[hbA${i}]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[hbD${i}]`));
// riser into CTA
const ctaStart = cuts[n - 1];
a.push(`anoisesrc=d=${ctaStart}:c=pink:a=0.5,highpass=f=800,afade=t=in:st=0:d=${ctaStart},volume=0.7[riser]`);
const mixIn = ["[drone]", ...cuts.map((_, i) => `[hd${i}]`), ...stabs.map((_, i) => `[st${i}]`), ...hbTimes.map((_, i) => `[hbD${i}]`), "[riser]"];
a.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=longest,aecho=0.7:0.5:90:0.3,alimiter=limit=0.9,atrim=0:${total},afade=t=out:st=${total - 0.6}:d=0.6,loudnorm=I=-14:TP=-1.5:LRA=9[aout]`);
// Note: heartbeat 2nd copy (hb2) intentionally unused → route to nullsink
a.push(`[hb2]anullsink`);

const fcAll = [...fc, ...a].join(";");
writeFileSync(`${WORK}/${variant}-filter.txt`, fcAll, "utf8");
const out = `${ROOT}/out/halloween-${variant}.mp4`;
const args = ["-y", ...inputs, "-/filter_complex", `${variant}-filter.txt`, "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", total.toFixed(2), out];
const r = spawnSync(FF, args, { cwd: WORK, stdio: "inherit" });
console.log("exit", r.status, out, "duration", total.toFixed(1));
