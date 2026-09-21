#!/usr/bin/env tsx
/**
 * scripts/batch-demand-gen-extend.mts — Étape 3.1: extend the demand-gen pipeline beyond
 * the 32 hand-audited SKUs in render-demand-gen.mjs, driven by trend+season priority
 * (Étape 2, src/lib/selectors/content-priority.ts) instead of a manual SOURCES list.
 *
 * Same visual design as render-demand-gen.mjs (title band, gold benefit pill, logo,
 * music, fades) — the graph-building functions here are a deliberate copy, not an import,
 * because that file is a top-level script with no exports, and this needed a version driven
 * by a DB-selected SKU list rather than a hardcoded array. Kept in sync by eye; if the
 * original's visual design changes, mirror it here too.
 *
 * ⚠️ SCOPE LIMITATION vs. the 32 original sources: those each had a manually audited clean
 * window (`ss`/`cleanDur`) and per-SKU delogo crop, done by watching the footage. This batch
 * has NO per-video audit — it applies a generic safe trim (skip the first 1s, stop 2s before
 * the end, capped at 6s) and never delogos. That means a supplier watermark or a bad opening
 * frame on any of these SKUs will ship uninspected. Mat should spot-check this batch's output
 * before a larger run — this is exactly the kind of quality gap the avant/après and assembly
 * corrections this session were about.
 *
 * DRAFT ONLY: every rendered clip lands in publication_queue as content_type='demand_gen_ext',
 * status='draft' — nothing here publishes or even reserves a schedule slot (draft rows aren't
 * slot-reserving; that only happens on approve, per Étape 5).
 *
 * Usage: node_modules/tsx/dist/cli.mjs scripts/batch-demand-gen-extend.mts --limit 20 --apply
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FONT = "fonts/DMSans.ttf";
const GOLD = "0xD4A853";
const NAVY = "0x1A2340";
const BENEFIT = "Livraison gratuite au Canada";
const SCRIM_OPACITY = 0.5;
const SCRIM_FRACTION = 0.25;
const MUSIC_DIR = "src/audio";
const MUSIC_VOL = 0.2;
const AUDIO_FADE = 1.0;
const VIDEO_FADE = 0.5;
const TITLE_FADE_START = 0.8;
const TITLE_FADE_DUR = 0.5;
const LOGO = "Logo/officiel-transparent.png";
const LOGO_W = 300;
const LOGO_H = Math.round((LOGO_W * 168) / 1284);
const PLATE_W = 352, PLATE_H = 85, PLATE_ALPHA = 0.7;
const RATIO = { W: 1080, H: 1920, titleFs: 48, benFs: 42, wrap: 24 }; // 9:16 only for this batch
const DURATION_SEC = 6; // single cut for this validation batch (see header)
const SEQUENTIAL_SLOT = "2026-12-31 00:00:00"; // placeholder — draft rows don't reserve a slot

for (const [label, p] of [["Font", FONT], ["Logo", LOGO]] as const) {
  if (!existsSync(p)) { console.error(`✗ ${label} not found: ${p} (run from the worktree root).`); process.exit(1); }
}

const SUPPLIER_BRANDS = ["Outsunny", "HOMCOM", "Aosom", "Qaba", "PawHut", "Vinsetto"];
const BRAND_PREFIX_RE = new RegExp(`^\\s*(?:${SUPPLIER_BRANDS.join("|")})®?\\s+`, "i");
function stripSupplierBrand(title: string): string {
  let prev, out = title;
  do { prev = out; out = out.replace(BRAND_PREFIX_RE, ""); } while (out !== prev);
  return out;
}
const up = (s: string) => s.toLocaleUpperCase("fr-CA");
const TRAILING_FILLER = new Set(["AVEC", "EN", "DE", "ET", "POUR"]);
function stripTrailingFiller(t: string): string {
  const parts = t.split(" ");
  while (parts.length > 1 && TRAILING_FILLER.has(up(parts[parts.length - 1]))) parts.pop();
  return parts.join(" ");
}
function formatVideoTitle(rawTitle: string, maxChars = 40): string {
  if (!rawTitle) return "";
  let t = stripSupplierBrand(rawTitle).replace(/…/g, " ").replace(/\.\.\./g, " ").replace(/\s*[—–]\s*/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\s+AVEC\b.*$/iu, "").trim();
  t = up(t);
  t = stripTrailingFiller(t);
  if (t.length > maxChars) {
    const slice = t.slice(0, maxChars + 1);
    const lastSpace = slice.lastIndexOf(" ");
    t = (lastSpace > 0 ? slice.slice(0, lastSpace) : t.slice(0, maxChars)).trim();
    t = stripTrailingFiller(t);
  }
  return t.trim();
}
function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = []; let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function overlayChain(titleLines: string[], lineDir: string): string {
  const { H, titleFs: baseTitleFs, benFs } = RATIO;
  const titleFs = Math.round(baseTitleFs * 1.25);
  const boldW = Math.max(2, Math.round(titleFs * 0.045));
  const titleShadow = "shadowcolor=black@0.8:shadowx=2:shadowy=2";
  const titleBox = `box=1:boxcolor=${NAVY}@0.70:boxborderw=4|8`;
  const lineSpacing = Math.round(titleFs * 1.3);
  const titleTop = Math.round(0.15 * H);
  const titleAlpha = `alpha=min(1\\,max(0\\,(t-${TITLE_FADE_START})/${TITLE_FADE_DUR}))`;
  const parts: string[] = [];
  titleLines.forEach((line, i) => {
    const file = `${lineDir}/t${i}.txt`;
    writeFileSync(file, line.toLocaleUpperCase("fr-CA"), "utf8");
    const y = titleTop + lineSpacing * i;
    parts.push(`drawtext=fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${titleFs}:borderw=${boldW}:bordercolor=white:${titleBox}:x=(w-text_w)/2:y=${y}:${titleShadow}:${titleAlpha}`);
  });
  const benFile = `${lineDir}/ben.txt`;
  writeFileSync(benFile, BENEFIT, "utf8");
  const benY = Math.round(0.82 * RATIO.H);
  const pad = Math.round(benFs * 0.55);
  parts.push(`drawtext=fontfile=${FONT}:textfile=${benFile}:fontcolor=${NAVY}:fontsize=${benFs}:box=1:boxcolor=${GOLD}@1:boxborderw=${pad}:x=(w-text_w)/2:y=${benY}`);
  return parts.join(",");
}

function buildFilter(drawChain: string, effDur: number): string {
  const { W, H } = RATIO;
  const base =
    `[0:v]split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,setsar=1[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
  const Hs = Math.round(SCRIM_FRACTION * H);
  const scrim = `color=c=${NAVY}:s=${W}x${Hs}:r=30,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${SCRIM_OPACITY}*255*(Y/(H-1))'[scrim]`;
  const fadeOutSt = Math.max(0, effDur - VIDEO_FADE).toFixed(3);
  const fade = `fade=t=in:d=${VIDEO_FADE},fade=t=out:st=${fadeOutSt}:d=${VIDEO_FADE}`;
  const logo =
    `[2:v]scale=${LOGO_W}:${LOGO_H}[logo_s];color=white@${PLATE_ALPHA}:size=${PLATE_W}x${PLATE_H}:r=30[plate];` +
    `[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[logo_backed]`;
  return `${base};${scrim};[base][scrim]overlay=0:${H - Hs}:shortest=1[scr];${logo};[scr]${drawChain}[txt];[txt][logo_backed]overlay=20:H-h-30[brand];[brand]${fade}[vout]`;
}
function buildAudioChain(effDur: number): string {
  const aFadeOutSt = Math.max(0, effDur - AUDIO_FADE).toFixed(3);
  return `[1:a]volume=${MUSIC_VOL},afade=t=in:d=${AUDIO_FADE},afade=t=out:st=${aFadeOutSt}:d=${AUDIO_FADE}[aout]`;
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const LIMIT = Number(flag("--limit") ?? "20");
const OUT_DIR = flag("--out") ?? "out_demandgen_ext";

/**
 * `products.name` is the raw ENGLISH Aosom feed title — the curated FR title lives only on
 * the live Shopify product, never backfilled into Turso (a known, previously-documented
 * gap). Fetched here per-SKU rather than trusting products.name, or every demand-gen-ext
 * title would ship in English on a French-primary storefront (caught during this batch's
 * own dry-run: the #1-priority SKU, a Christmas tree, rendered "6' PRE LIT ARTIFICIAL...").
 */
async function fetchShopifyTitle(sku: string): Promise<string | null> {
  const shop = "27u5y2-kp.myshopify.com";
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: `{ products(first: 1, query: "sku:${sku}") { edges { node { title } } } }` }),
  });
  const json = (await res.json()) as { data?: { products?: { edges?: { node?: { title?: string } }[] } } };
  return json.data?.products?.edges?.[0]?.node?.title ?? null;
}

async function ffprobeDuration(file: string): Promise<number> {
  const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(String(out).trim());
}

async function main(): Promise<void> {
  const { topPriorityCandidates } = await import("@/lib/selectors/content-priority");
  const { addToQueue, ensureSchema } = await import("@/lib/database");
  const { put } = await import("@vercel/blob");
  const dbClient = await ensureSchema();

  const candidates = await topPriorityCandidates(
    `p.video IS NOT NULL AND p.video != ''`,
    [],
    LIMIT,
  );
  console.log(`\n🎬 demand-gen extension — ${candidates.length} SKU(s) — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  for (const c of candidates) {
    console.log(`  ${c.sku.padEnd(14)} priority=${c.priority.toFixed(3)} (velocity=${c.velocity14d} discount=${c.hasDiscount} season=${c.seasonalMultiplier})`);
  }
  if (!APPLY) { console.log("\nDry-run. --apply pour rendre."); return; }

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync("src", { recursive: true });
  const tracks = readdirSync(MUSIC_DIR).filter((f: string) => f.endsWith(".mp3"));
  const music = path.join(MUSIC_DIR, tracks[0]);

  let ok = 0, fail = 0;
  for (const c of candidates) {
    try {
      const row = await dbClient.execute({ sql: `SELECT name, video, price FROM products WHERE sku = ?`, args: [c.sku] });
      const r = row.rows[0] as unknown as { name: string; video: string; price: number } | undefined;
      if (!r?.video) { console.log(`  ${c.sku} no video, skip`); continue; }
      const frTitle = (await fetchShopifyTitle(c.sku)) ?? r.name; // fallback: EN, better than nothing

      const src = `src/${c.sku}.mp4`;
      const buf = Buffer.from(await (await fetch(r.video)).arrayBuffer());
      writeFileSync(src, buf);
      const dur = await ffprobeDuration(src);
      const ss = Math.min(1.0, Math.max(0, dur - DURATION_SEC - 0.5));
      const effDur = Math.min(DURATION_SEC, Math.max(1, dur - ss - 1.5));

      const lineDir = `tmp_dg_ext/${c.sku}`;
      mkdirSync(lineDir, { recursive: true });
      const titleLines = wrap(formatVideoTitle(frTitle), RATIO.wrap).slice(0, 2);
      const filter = `${buildFilter(overlayChain(titleLines, lineDir), effDur)};${buildAudioChain(effDur)}`;
      const outFile = path.join(OUT_DIR, `${c.sku}_9x16_6s.mp4`);
      const args = [
        "-y", "-nostdin", "-loglevel", "error",
        "-ss", String(ss), "-i", src,
        "-stream_loop", "-1", "-i", music,
        "-loop", "1", "-i", LOGO,
        "-t", String(effDur),
        "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outFile,
      ];
      execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      rmSync(lineDir, { recursive: true, force: true });
      rmSync(src, { force: true });

      const fileBuf = readFileSync(outFile);
      const { url } = await put(`content-batches/demand-gen-ext/${c.sku}_9x16_6s.mp4`, fileBuf, {
        access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
      });

      await addToQueue({
        contentType: "demand_gen_ext",
        contentId: c.sku,
        platform: "facebook",
        payload: JSON.stringify({ sku: c.sku, productName: frTitle, blobUrl: url, ratio: "9:16", durationSec: effDur }),
        scheduledAt: `${SEQUENTIAL_SLOT.slice(0, 10)} ${String(Math.floor(Math.random() * 23)).padStart(2, "0")}:00:00`,
        status: "draft",
        metadata: { priority: c.priority, velocity14d: c.velocity14d, hasDiscount: c.hasDiscount, seasonalMultiplier: c.seasonalMultiplier },
      });
      console.log(`  ${c.sku} ✓ ${url}`);
      ok++;
    } catch (e) {
      fail++;
      console.log(`  ${c.sku} FAIL: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  rmSync("tmp_dg_ext", { recursive: true, force: true });
  console.log(`\n=== ok=${ok} fail=${fail} ===`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
