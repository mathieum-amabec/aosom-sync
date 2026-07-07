// Demand Gen video renderer — FULL BATCH (13 viable sources × ratios × durations).
// Transforms existing real product MP4s into Demand Gen assets. No AI generation.
//   16:9 → scale+pad (native ratio)   |   1:1 / 9:16 → blurred-fill padded canvas
//   Per source: trim to the clean window (ss + cleanDur), delogo only where a logo is persistent.
//   Overlay (drawtext): FR title (white, faux-bold, drop shadow, Navy 70% backing box) at the TOP safe zone (y=15%) +
//   benefit as a Gold pill (Navy text) at the BOTTOM safe zone (y=82%), over a Navy 50%/25%-tall scrim.
//   Titles: UPPERCASE (fr-CA), em/en dashes stripped, smart-shortened to ~40 chars on a
//   word boundary (formatVideoTitle — no ellipsis, drops decorative/filler words), max 2 lines.
// Run from the worktree root:  node scripts/render-demand-gen.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";

const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const FONT = "fonts/DMSans.ttf";
const GOLD = "0xD4A853";
const NAVY = "0x1A2340"; // brand navy (VIDEO_BRAND.colors.navy #1A2340)
const BENEFIT = "Livraison gratuite au Canada";
const SCRIM_OPACITY = 0.50;   // Navy bottom gradient peak alpha (was 0.35)
const SCRIM_FRACTION = 0.25;  // band height = 25% of canvas (was 0.18)

// Background music (v2). Replaces the source-clip audio. Chosen track: ambient/chill,
// suited to furniture/outdoor lifestyle. Swap via MUSIC_BIN env or this constant.
const MUSIC = process.env.MUSIC_BIN || "src/audio/joyinsound-no-copyright-chill-music-403411.mp3";
const MUSIC_VOL = 0.2;        // -20dB-ish; sits under the (silent) visuals
const AUDIO_FADE = 1.0;       // music fade in/out (s)
const VIDEO_FADE = 0.5;       // video fade from/to black (s)
const TITLE_FADE_START = 0.8; // title fade-in begins (s)
const TITLE_FADE_DUR = 0.5;   // title fade-in ramp (s)
// Brand watermark is now the real logo (image overlay), not drawtext text.
// Transparent PNG produced from logo/Ameublo/officiel.webp via colorkey=white.
const LOGO = process.env.LOGO_BIN || "Logo/officiel-transparent.png";
const LOGO_W = 300;   // logo width px on every ratio
// The transparent PNG is the tight 1284×168 lockup, so it scales cleanly.
const LOGO_H = Math.round(LOGO_W * 168 / 1284);  // ≈39
// White semi-transparent backing plate so the navy wordmark reads on any footage.
const PLATE_W = 352;   // logo + even padding (logo centered on the plate)
const PLATE_H = 85;
const PLATE_ALPHA = 0.7;

// Fail loud if the brand font or logo is missing: drawtext silently skips text
// when fontfile can't be opened, and a missing overlay input errors mid-render.
for (const [label, p] of [["Font", FONT], ["Logo", LOGO]]) {
  if (!existsSync(p)) {
    console.error(`✗ ${label} not found: ${p} (run from the worktree root).`);
    process.exit(1);
  }
}

// 13 viable sources (audit). ss/cleanDur = clean-window trim (s). buckets = duration cuts to emit.
const SOURCES = [
  { sku:"01-0415",      title:"Base de parasol carrée résine 9 kg — bronze", ss:4.0, cleanDur:13.5, delogo:null, buckets:[6,15] },
  { sku:"845-774V00BK", title:"Jardinière surélevée acier galvanisé avec tiges renforcées 180cm", ss:0.5, cleanDur:17.5, delogo:"delogo=x=6:y=6:w=260:h=120", buckets:[6,15] },
  { sku:"01-0893",      title:"Balançoire de jardin double à bascule pour patio", ss:2.0, cleanDur:14.0, delogo:null, buckets:[6,15] },
  { sku:"845-039V01GY", title:"Jardinière surélevée galvanisée acier 120x60x30cm", ss:3.0, cleanDur:27.0, delogo:null, buckets:[6,15,30] },
  { sku:"845-335",      title:"Agenouilloir de jardin pliable avec coussin mousse EVA", ss:1.0, cleanDur:34.0, delogo:null, buckets:[6,15,30] },
  { sku:"845-518GY",    title:"Bac de jardinage surélevé galvanisé 241 x 91 x 30 cm", ss:13.0, cleanDur:11.0, delogo:null, buckets:[6,15] },
  { sku:"845-792V00YL", title:"Jardinière surélevée avec treillis pour plantes grimpantes — jaune", ss:6.0, cleanDur:11.0, delogo:null, buckets:[6,15] },
  { sku:"84A-054V05BK", title:"Balancelle de patio 3 places avec auvent ajustable", ss:7.0, cleanDur:28.0, delogo:null, buckets:[6,15,30] },
  { sku:"84B-136",      title:"Coussins de remplacement pour banc 3 places extérieur", ss:4.0, cleanDur:12.0, delogo:null, buckets:[6,15] },
  { sku:"84B-146BU",    title:"Chaise longue pliante 5 positions avec trou visage", ss:3.0, cleanDur:15.0, delogo:null, buckets:[6,15] },
  { sku:"84C-226CG",    title:"Rideaux gazebo universels 4 panneaux 10' x 12' — Foncé", ss:0.5, cleanDur:11.5, delogo:null, buckets:[6,15] },
  { sku:"84H-209V00CG", title:"Bac surélevé galvanisé 152 x 91 x 61 cm", ss:7.0, cleanDur:16.0, delogo:null, buckets:[6,15] },
  { sku:"D51-277V01",   title:"Enclos pour poules extérieur avec toit 3,0 x 4,0 x 2,0 m", ss:0.5, cleanDur:22.5, delogo:null, buckets:[6,15] },
  // --- Patio & Garden pilot (audit 2026-06-20, filmstrip 1fps). All 852x480 → soft 9:16 upscale. ---
  // Solid (clean window confirmed by full-frame grabs):
  { sku:"331-015",      title:"Ensemble jeu 4-en-1 glissoire balançoire panier basketball", ss:4.0, cleanDur:36.0, delogo:null, buckets:[6,15,30] },
  { sku:"841-086",      title:"Ensemble sectionnelle patio 4 pièces rotin tressé", ss:3.0, cleanDur:15.0, delogo:null, buckets:[6,15] },
  { sku:"343-049RD",    title:"Bac à sable octogonal avec couvercle et bancs", ss:4.0, cleanDur:14.0, delogo:null, buckets:[6,15] },
  { sku:"840-150GY",    title:"Auvent rétractable patio aluminium réglable", ss:5.0, cleanDur:12.0, delogo:null, buckets:[6,15] },
  { sku:"840-183GY",    title:"Store rétractable manuel patio 305x152cm ajustable", ss:6.0, cleanDur:13.0, delogo:null, buckets:[6,15] },
  // Marginal (6s only — short clean window / decorative graphics):
  { sku:"01-0368",      title:"Chaise longue pliable avec trou visage 3 positions", ss:15.0, cleanDur:8.0, delogo:null, buckets:[6] },
  { sku:"840-070CG",    title:"Parasol de patio rond 10 pieds avec manivelle", ss:2.0, cleanDur:10.0, delogo:null, buckets:[6] },
  { sku:"840-014V01BG", title:"Tente pliable 10x10 pieds avec parois maillées", ss:10.0, cleanDur:9.0, delogo:null, buckets:[6] },
  { sku:"343-029",      title:"Bac à sable en bois avec auvent réglable pour enfants", ss:25.0, cleanDur:7.0, delogo:null, buckets:[6] },
  // --- Phase 2 marginal SKUs (audit). cleanDur≥10 → [6,15] (3 fans + cabinet); sideboards (cleanDur 9) → [6]. ---
  { sku:"824-033WT",    title:"Ventilateur sur pied oscillant avec télécommande et écran LED — blanc", ss:3.0, cleanDur:13.0, delogo:null, buckets:[6,15] },
  { sku:"824-048V80RD", title:"Ventilateur tour oscillant 3 vitesses avec minuterie 12h et télécommande", ss:31.0, cleanDur:11.0, delogo:null, buckets:[6,15] },
  { sku:"824-056V80WT", title:"Ventilateur tour oscillant avec écran LED tactile et télécommande — blanc", ss:26.0, cleanDur:14.0, delogo:null, buckets:[6,15] },
  { sku:"837-339V80WT", title:"Armoire de pharmacie murale avec tablettes ajustables et porte unique", ss:5.0, cleanDur:12.0, delogo:null, buckets:[6,15] },
  { sku:"838-075",      title:"Buffet sideboard haute brillance 2 tiroirs 2 portes — gris et noir", ss:31.0, cleanDur:9.0, delogo:null, buckets:[6] },
  { sku:"838-075WT",    title:"Buffet sideboard haute brillance 2 tiroirs 2 portes — blanc", ss:21.0, cleanDur:9.0, delogo:null, buckets:[6] },
  // --- Phase 2: Home Furnishings (audit 2026-06-22, filmstrip 1fps). 852x478/480 except 837 (1080p). ---
  // 13 ✅ "prêts". delogo only where a persistent HOMCOM corner watermark is present (852-wide).
  { sku:"823-002V80",   title:"Climatiseur portatif 10 000 BTU 3-en-1 blanc", ss:3.0, cleanDur:18.0, delogo:"delogo=x=6:y=6:w=108:h=70", buckets:[6,15] },
  { sku:"823-010V81",   title:"Climatiseur portatif 10 000 BTU silencieux noir", ss:3.0, cleanDur:18.0, delogo:"delogo=x=6:y=6:w=108:h=70", buckets:[6,15] },
  { sku:"824-033BK",    title:"Ventilateur sur pied oscillant avec télécommande", ss:1.0, cleanDur:19.0, delogo:null, buckets:[6,15] },
  { sku:"824-051V80BK", title:"Ventilateur tour oscillant 3 vitesses minuterie", ss:1.0, cleanDur:34.0, delogo:null, buckets:[6,15,30] },
  { sku:"824-056V80BK", title:"Ventilateur tour oscillant silencieux pour chambre", ss:1.0, cleanDur:34.0, delogo:null, buckets:[6,15,30] },
  { sku:"834-295",      title:"Armoire à pharmacie murale acier verrouillable", ss:1.0, cleanDur:15.0, delogo:null, buckets:[6,15] },
  { sku:"831-790V01WT", title:"Cadre de lit queen en métal avec tête de lit", ss:1.0, cleanDur:30.0, delogo:"delogo=x=6:y=6:w=108:h=70", buckets:[6,15,30] },
  { sku:"838-075BK",    title:"Buffet enfilade laqué 2 tiroirs 2 portes noir", ss:1.0, cleanDur:20.0, delogo:null, buckets:[6,15] },
  { sku:"83A-188V81BK", title:"Buffet de cuisine rangement tablettes réglables noir", ss:4.0, cleanDur:16.0, delogo:null, buckets:[6,15] },
  { sku:"83A-188V81WT", title:"Buffet de cuisine moderne rangement blanc", ss:4.0, cleanDur:18.0, delogo:null, buckets:[6,15] },
  { sku:"835-511GY",    title:"Buffet enfilade moderne tiroirs et rangement gris", ss:4.0, cleanDur:30.0, delogo:null, buckets:[6,15,30] },
  { sku:"835-511WT",    title:"Buffet enfilade moderne avec tablettes blanc", ss:4.0, cleanDur:28.0, delogo:null, buckets:[6,15,30] },
  { sku:"835-135V80RB", title:"Ensemble table de bar 3 pièces avec tabourets", ss:4.0, cleanDur:14.0, delogo:null, buckets:[6,15] },
];

// SKUs to skip at render: the source footage burns in a HOMCOM supplier logo that the
// delogo crop can't fully remove, so we don't ship demand-gen videos for them. Filtered
// out of the render set below (even if named via --only).
const EXCLUDED_SKUS = ['823-002V80', '823-010V81'];

const RATIOS = {
  "16:9": { W:1920, H:1080, titleFs:54, benFs:46, wrap:42 },
  "1:1":  { W:1080, H:1080, titleFs:46, benFs:40, wrap:24 },
  "9:16": { W:1080, H:1920, titleFs:48, benFs:42, wrap:24 },
};

function wrap(text, max) {
  const words = text.split(/\s+/);
  const lines = []; let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Smart title shortener for the overlay — no ellipsis, no mid-word cut, drops
// decorative descriptors + trailing filler so the title fits ~40 chars and reads well.
// PORT of src/lib/video-title-utils.ts formatVideoTitle — keep the two in sync.
const REMOVE_WORDS = new Set(["PORTATIF", "OSCILLANT", "CARRÉ", "CARRÉE", "RÉSINE"]);
const LEADING_DROP = new Set(["ENSEMBLE"]);
const TRAILING_FILLER = new Set(["AVEC", "EN", "DE", "ET", "POUR"]);
const MATERIALS = ["MÉTAL", "ACIER", "BOIS", "ROTIN", "VERRE", "ALUMINIUM"];
const PHRASE_REDUCTIONS = [[/\bBASE DE PARASOL\b/g, "BASE PARASOL"]];

// Supplier brands stripped from the START of the title, before anything else —
// kept in sync with src/lib/video-title-utils.ts (no supplier brand in overlays).
const SUPPLIER_BRANDS = ["Outsunny", "HOMCOM", "Aosom", "Qaba", "PawHut", "Vinsetto"];
const BRAND_PREFIX_RE = new RegExp(`^\\s*(?:${SUPPLIER_BRANDS.join("|")})®?\\s+`, "i");
function stripSupplierBrand(title) {
  let prev, out = title;
  do { prev = out; out = out.replace(BRAND_PREFIX_RE, ""); } while (out !== prev);
  return out;
}

const up = (s) => s.toLocaleUpperCase("fr-CA");
function stripTrailingFiller(t) {
  const parts = t.split(" ");
  while (parts.length > 1 && TRAILING_FILLER.has(up(parts[parts.length - 1]))) parts.pop();
  return parts.join(" ");
}
function formatVideoTitle(rawTitle, maxChars = 40, opts = {}) {
  const { uppercase = true, aggressive = true } = opts;
  if (!rawTitle) return "";
  let t = stripSupplierBrand(rawTitle)
    .replace(/…/g, " ")
    .replace(/\.\.\./g, " ")
    .replace(/\s*[—–]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (aggressive) {
    t = t.replace(/\s+AVEC\b.*$/iu, "").trim(); // drop the "AVEC …" tail (aggressive only)
    t = up(t);
    const lead = t.split(" ");
    if (lead.length > 1 && LEADING_DROP.has(lead[0])) t = lead.slice(1).join(" ");
    t = t.replace(new RegExp(`\\bEN (${MATERIALS.join("|")})\\b`, "gu"), "$1");
    for (const [pattern, replacement] of PHRASE_REDUCTIONS) t = t.replace(pattern, replacement);
    t = t.split(" ").filter((w) => !REMOVE_WORDS.has(w)).join(" ").replace(/\s+/g, " ").trim();
  }
  t = stripTrailingFiller(t);
  if (t.length > maxChars) {
    const slice = t.slice(0, maxChars + 1);
    const lastSpace = slice.lastIndexOf(" ");
    t = (lastSpace > 0 ? slice.slice(0, lastSpace) : t.slice(0, maxChars)).trim();
    t = stripTrailingFiller(t);
  }
  t = t.trim();
  return uppercase ? up(t) : t;
}

function overlayChain(cfg, titleLines, lineDir) {
  const { H, titleFs: baseTitleFs, benFs } = cfg;
  const titleFs = Math.round(baseTitleFs * 1.25);          // title +25%
  // Only DMSans.ttf is shipped (no bold cut) — fake bold with a same-color outline.
  const boldW = Math.max(2, Math.round(titleFs * 0.045));
  const titleShadow = "shadowcolor=black@0.8:shadowx=2:shadowy=2";
  // Navy 70% backing box behind each title line for legibility. boxborderw=4|8 =
  // 4px vertical / 8px horizontal padding. Square corners — drawtext/drawbox have
  // no rounded-corner option in FFmpeg (same as the Gold benefit pill below).
  const titleBox = `box=1:boxcolor=${NAVY}@0.70:boxborderw=4|8`;
  const lineSpacing = Math.round(titleFs * 1.30);
  const titleTop = Math.round(0.15 * H);                   // top safe zone
  // Title fade-in: alpha 0→1 ramping from TITLE_FADE_START over TITLE_FADE_DUR.
  // Commas are escaped (\,) so the filtergraph parser keeps them inside the expr
  // instead of splitting filters. Animates the whole title element (text+box+border).
  const titleAlpha =
    `alpha=min(1\\,max(0\\,(t-${TITLE_FADE_START})/${TITLE_FADE_DUR}))`;
  const parts = [];
  titleLines.forEach((line, i) => {
    const file = `${lineDir}/t${i}.txt`;
    // Title in UPPERCASE. FFmpeg drawtext has no upper() function (it renders the
    // literal token), so we uppercase in JS — fr-CA locale handles é→É, à→À, ç→Ç.
    writeFileSync(file, line.toLocaleUpperCase("fr-CA"), "utf8");
    const y = titleTop + lineSpacing * i;
    parts.push(`drawtext=fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${titleFs}:borderw=${boldW}:bordercolor=white:${titleBox}:x=(w-text_w)/2:y=${y}:${titleShadow}:${titleAlpha}`);
  });
  // Benefit: Navy text on a Gold padded box (pill) at the bottom safe zone.
  // Note: drawtext boxes are square-cornered; padding gives the pill shape.
  const benFile = `${lineDir}/ben.txt`;
  writeFileSync(benFile, BENEFIT, "utf8");
  const benY = Math.round(0.82 * H);
  const pad = Math.round(benFs * 0.55);
  parts.push(`drawtext=fontfile=${FONT}:textfile=${benFile}:fontcolor=${NAVY}:fontsize=${benFs}:box=1:boxcolor=${GOLD}@1:boxborderw=${pad}:x=(w-text_w)/2:y=${benY}`);
  // The brand watermark is no longer drawtext — it's the real logo overlaid as an
  // image in buildFilter() (input [2:v]). overlayChain now only emits title + benefit.
  return parts.join(",");
}

function buildFilter(ratio, cfg, drawChain, delogo, effDur) {
  const { W, H } = cfg;
  const pre = delogo ? `${delogo},` : "";
  let base;
  if (ratio === "16:9") {
    base = `[0:v]${pre}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[base]`;
  } else {
    base = `[0:v]${pre}split=2[a][b];` +
           `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,setsar=1[bg];` +
           `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
           `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
  }
  const Hs = Math.round(SCRIM_FRACTION * H);
  const scrim = `color=c=${NAVY}:s=${W}x${Hs}:r=30,format=rgba,` +
                `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${SCRIM_OPACITY}*255*(Y/(H-1))'[scrim]`;
  // Video transitions: fade from black at start, to black at end (last VIDEO_FADE s).
  const fadeOutSt = Math.max(0, effDur - VIDEO_FADE).toFixed(3);
  const fade = `fade=t=in:d=${VIDEO_FADE},fade=t=out:st=${fadeOutSt}:d=${VIDEO_FADE}`;
  // Brand logo (input [2:v]) on a white semi-transparent plate so the navy wordmark
  // reads on light/busy footage. Scale logo → center it on the plate → overlay the
  // backed logo bottom-left (20px left, 30px bottom). Before the fade so it fades too.
  const logo =
    `[2:v]scale=${LOGO_W}:${LOGO_H}[logo_s];` +
    `color=white@${PLATE_ALPHA}:size=${PLATE_W}x${PLATE_H}:r=30[plate];` +
    `[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[logo_backed]`;
  return `${base};${scrim};[base][scrim]overlay=0:${H - Hs}:shortest=1[scr];${logo};` +
         `[scr]${drawChain}[txt];[txt][logo_backed]overlay=20:H-h-30[brand];[brand]${fade}[vout]`;
}

// Background-music branch (input #1): 20% volume, 1s fade in/out, looped to fill
// (the input is opened with -stream_loop -1). Replaces the source-clip audio.
function buildAudioChain(effDur) {
  const aFadeOutSt = Math.max(0, effDur - AUDIO_FADE).toFixed(3);
  return `[1:a]volume=${MUSIC_VOL},afade=t=in:d=${AUDIO_FADE},afade=t=out:st=${aFadeOutSt}:d=${AUDIO_FADE}[aout]`;
}

const t0 = Date.now();
const report = [];
let ok = 0, fail = 0, bytes = 0;
// Optional CLI SKU filter: `node scripts/render-demand-gen.mjs 01-0415 845-774V00BK`
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = ONLY.length ? SOURCES.filter((s) => ONLY.includes(s.sku)) : SOURCES;
// Always drop EXCLUDED_SKUS (supplier-logo footage) — even if explicitly named via --only.
const sources = selected.filter((s) => !EXCLUDED_SKUS.includes(s.sku));
if (ONLY.length) {
  const missing = ONLY.filter((x) => !sources.some((s) => s.sku === x));
  if (missing.length) { console.error("Unknown SKU(s):", missing.join(", ")); process.exit(1); }
  console.log(`Rendering ${sources.length} source(s): ${sources.map((s) => s.sku).join(", ")}`);
}
for (const s of sources) {
  const src = `src/${s.sku}.mp4`;
  const outDir = `out/demand-gen/${s.sku}`;
  mkdirSync(outDir, { recursive: true });
  for (const [ratio, cfg] of Object.entries(RATIOS)) {
    const titleLines = wrap(formatVideoTitle(s.title), cfg.wrap).slice(0, 2);
    for (const bucket of s.buckets) {
      const effDur = Math.min(bucket, s.cleanDur);
      const rtag = ratio.replace(":", "x");
      const lineDir = `tmp_lines/${s.sku}_${rtag}_${bucket}`;
      mkdirSync(lineDir, { recursive: true });
      const videoGraph = buildFilter(ratio, cfg, overlayChain(cfg, titleLines, lineDir), s.delogo, effDur);
      const filter = `${videoGraph};${buildAudioChain(effDur)}`;
      const out = `${outDir}/${s.sku}_${rtag}_${bucket}s.mp4`;
      const args = [
        "-y", "-nostdin", "-loglevel", "error",
        "-ss", String(s.ss), "-i", src,        // input 0: product clip (seeked)
        "-stream_loop", "-1", "-i", MUSIC,      // input 1: bg music, looped to fill
        "-loop", "1", "-i", LOGO,               // input 2: brand logo (held for whole clip)
        "-t", String(effDur),                   // output duration cap (bounds all)
        "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ];
      process.stdout.write(`${out} (${effDur}s) … `);
      try {
        execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
        const sz = statSync(out).size; bytes += sz; ok++;
        report.push({ sku: s.sku, ratio, bucket, effective_sec: Number(effDur.toFixed(1)), file: out, size: sz, ok: true });
        console.log("ok");
      } catch (e) {
        fail++;
        report.push({ sku: s.sku, ratio, bucket, effective_sec: Number(effDur.toFixed(1)), file: out, ok: false, error: String(e.stderr || e.message).slice(0, 300) });
        console.log("FAIL");
      }
      rmSync(lineDir, { recursive: true, force: true });
    }
  }
}
rmSync("tmp_lines", { recursive: true, force: true });
const elapsed = (Date.now() - t0) / 1000;
writeFileSync("out/render-report.json", JSON.stringify({ ok, fail, total_bytes: bytes, elapsed_sec: Number(elapsed.toFixed(1)), assets: report }, null, 2));
console.log(`\n=== BATCH DONE === ok=${ok} fail=${fail} · ${(bytes/1048576).toFixed(1)} MB · ${elapsed.toFixed(1)}s`);
if (fail) report.filter(r => !r.ok).forEach(r => console.log(`  FAIL ${r.file}: ${r.error}`));
