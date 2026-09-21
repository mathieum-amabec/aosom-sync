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
 * CORRECTION ROUND 2 (this session — round 1's `analyzeClip` reuse still shipped defects on
 * 3 more videos, root-caused by frame-by-frame review of the raw sources, not patched blind):
 *
 *   1. 837-164WT still showed the HOMCOM icon: a full 1fps contact-sheet of the RAW source
 *      revealed the logo isn't just an opening card — it flickers on/off through almost the
 *      WHOLE clip (a recurring brand bumper animation). `analyzeClip`'s 12-frame sample
 *      (~1/3.2s) has real gaps wide enough to miss a ~1s flicker.
 *   2. 830-243 (Christmas tree) was never zoomed out enough to show the whole tree: Vision's
 *      OLD rubric (`FRAME_PROMPT` in video-scene-selector.ts, built for sequential-ad B-roll)
 *      scores "dynamic, well-lit, no text" — it does not penalize a shot too TIGHT to show the
 *      full product, so a hands-decorating close-up scored well despite never showing the tree.
 *   3. 831-425 kept a 2s English caption card at the very start: for a clip under ~20s,
 *      `bestWindow`'s target collapses to the WHOLE clip (`min(maxSeg, duration)`), forcing
 *      `startTime=0` regardless of a bad opening, because the clip's average score across 16s
 *      of good footage + 2s of bad still came out high enough — the window's start was never
 *      actually searched at the render's real 6s duration.
 *
 * Fixed by a new dedicated module, `@/lib/demand-gen-clean-window.ts` (see its header for the
 * full mechanism): denser (~1/sec) sampling, a stricter dual-gate prompt (full-product-visible
 * AND text/logo-free, independently), and a genuine 6s sub-window search over the real
 * per-frame scores instead of trusting the analyzer's 15-20s window's start time. A POST-RENDER
 * check (`verifyRenderedClip`) re-scores the actual output before it's allowed into the queue —
 * a clip that fails is logged and SKIPPED, never shipped with the defect (see the main loop).
 *
 * KNOWN LIMITATION found by this same round-2 pass, left open by design rather than patched
 * blind: `findCleanWindow` scores a candidate window by its AVERAGE per-frame score, so a
 * window can pass even when the camera pans/zooms WITHIN it — average-good but not every
 * frame good. Confirmed by hand for two `needsRegen` SKUs: 830-243's chosen window opens on
 * a tight decorating close-up and only reveals the whole tree by its end (avg score cleared
 * the bar, but the first ~2s alone would not have); 924-067V00WT similarly. A real fix needs
 * a sliding MINIMUM-score sub-window (every sampled frame in the final window individually
 * clears the bar), not an average — left for a follow-up since `verifyRenderedClip` already
 * catches the resulting bad clips and correctly withholds them (see `needsRegen` below)
 * rather than shipping the defect; nothing broken ships today, it's a missed-yield gap only.
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

function buildFilter(drawChain: string, effDur: number, delogo: string | null): string {
  const { W, H } = RATIO;
  const pre = delogo ? `${delogo},` : "";
  const base =
    `[0:v]${pre}split=2[a][b];` +
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
/** Targeted re-render (e.g. fixing specific SKUs) instead of a fresh priority scan. */
const ONLY = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

/**
 * Permanent exclusions — mirrors EXCLUDED_SKUS in render-demand-gen.mjs (supplier-logo
 * footage that no crop can fix). 837-164WT: round-2 investigation (1fps contact sheet of
 * the raw source) showed the HOMCOM logo + an English caption card ("Shoe Cabinet / Create
 * a tidy and welcoming entrance") isn't an opening bumper — it's a recurring on/off overlay
 * that persists through nearly the entire clip (best 6s window still averaged 2.0/9 on the
 * strict full-video scan). A larger delogo box can't help: the graphic is large and
 * roughly frame-centered, not a small corner icon. Always dropped, even via --only.
 */
const EXCLUDED_SKUS = ["837-164WT"];

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

async function main(): Promise<void> {
  const { topPriorityCandidates } = await import("@/lib/selectors/content-priority");
  const { addToQueue, ensureSchema } = await import("@/lib/database");
  const { put } = await import("@vercel/blob");
  const dbClient = await ensureSchema();

  const allCandidates = await topPriorityCandidates(
    `p.video IS NOT NULL AND p.video != ''`,
    [],
    ONLY ? 5000 : LIMIT,
  );
  const candidates = (ONLY ? allCandidates.filter((c) => ONLY.includes(c.sku)) : allCandidates)
    .filter((c) => !EXCLUDED_SKUS.includes(c.sku));
  console.log(`\n🎬 demand-gen extension — ${candidates.length} SKU(s) — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  for (const c of candidates) {
    console.log(`  ${c.sku.padEnd(14)} priority=${c.priority.toFixed(3)} (velocity=${c.velocity14d} discount=${c.hasDiscount} season=${c.seasonalMultiplier})`);
  }
  if (!APPLY) { console.log("\nDry-run. --apply pour rendre."); return; }

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync("src", { recursive: true });
  const tracks = readdirSync(MUSIC_DIR).filter((f: string) => f.endsWith(".mp3")).map((f) => path.join(MUSIC_DIR, f));
  const { pickMusic } = await import("@/lib/video-ad-composer");
  const { findCleanWindow, verifyRenderedClip } = await import("@/lib/demand-gen-clean-window");

  let ok = 0, fail = 0, needsRegen = 0;
  for (const c of candidates) {
    try {
      const row = await dbClient.execute({ sql: `SELECT name, video, price, product_type FROM products WHERE sku = ?`, args: [c.sku] });
      const r = row.rows[0] as unknown as { name: string; video: string; price: number; product_type: string | null } | undefined;
      if (!r?.video) { console.log(`  ${c.sku} no video, skip`); continue; }
      const frTitle = (await fetchShopifyTitle(c.sku)) ?? r.name; // fallback: EN, better than nothing
      // Category-aware bed, same as every other pipeline — this script previously hardcoded
      // tracks[0] for every SKU regardless of category, a separate bug fixed alongside this.
      const music = pickMusic(c.sku, tracks, r.product_type);

      const src = `src/${c.sku}.mp4`;
      const buf = Buffer.from(await (await fetch(r.video)).arrayBuffer());
      writeFileSync(src, buf);
      const win = await findCleanWindow(src, DURATION_SEC);
      console.log(`    window: [${win.startTime.toFixed(1)}-${win.endTime.toFixed(1)}] ok=${win.ok} (${win.reason})`);
      // win.ok=false means no window cleared the strict source-level bar anywhere in the clip
      // — confirmed on 2 SKUs to mean a small corner icon flickering through almost the WHOLE
      // video (not just an intro), which no window CHOICE can dodge. Rather than skip outright,
      // fall through and try the best-available window with delogo applied from the start —
      // the post-render check (correctly scoped now, see scoreFrameRendered) is the real
      // gatekeeper either way; a bad source-level score does not have to mean a bad final clip.
      const startWithDelogo = !win.ok;

      const lineDir = `tmp_dg_ext/${c.sku}`;
      mkdirSync(lineDir, { recursive: true });
      const titleLines = wrap(formatVideoTitle(frTitle), RATIO.wrap).slice(0, 2);
      const outFile = path.join(OUT_DIR, `${c.sku}_9x16_6s.mp4`);

      // Render, then verify the ACTUAL OUTPUT — a clean source window is necessary but not
      // sufficient (the crop/blur-pad itself could still leave something visible). On a first
      // failure, retry ONCE with a top-left delogo crop (covers a small persistent corner icon
      // that a window choice alone cannot dodge, e.g. a bumper that flickers through the whole
      // clip) before giving up and skipping the SKU entirely.
      const renderOnce = (delogo: string | null) => {
        const filter = `${buildFilter(overlayChain(titleLines, lineDir), DURATION_SEC, delogo)};${buildAudioChain(DURATION_SEC)}`;
        const args = [
          "-y", "-nostdin", "-loglevel", "error",
          "-ss", String(win.startTime), "-i", src,
          "-stream_loop", "-1", "-ss", String(music.startOffset), "-i", music.track,
          "-loop", "1", "-i", LOGO,
          "-t", String(DURATION_SEC),
          "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outFile,
        ];
        execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      };

      renderOnce(startWithDelogo ? "delogo=x=6:y=6:w=140:h=90" : null);
      let verify = await verifyRenderedClip(outFile);
      console.log(`    verify: ok=${verify.ok} (${verify.reason})`);
      if (!verify.ok && !startWithDelogo) {
        console.log(`    retrying with a top-left delogo crop…`);
        renderOnce("delogo=x=6:y=6:w=140:h=90");
        verify = await verifyRenderedClip(outFile);
        console.log(`    verify (retry): ok=${verify.ok} (${verify.reason})`);
      }
      rmSync(lineDir, { recursive: true, force: true });
      rmSync(src, { force: true });
      if (!verify.ok) {
        console.log(`    ⚠ NEEDS REGEN: rendered clip still failed verification after retry — not queued`);
        needsRegen++;
        continue;
      }

      const fileBuf = readFileSync(outFile);
      const { url } = await put(`content-batches/demand-gen-ext/${c.sku}_9x16_6s.mp4`, fileBuf, {
        access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
      });

      // Re-rendering the same SKU (e.g. this session's title-language and scene-selection
      // fixes) must not leave the old, wrong draft sitting next to the corrected one.
      await dbClient.execute({
        sql: `UPDATE publication_queue SET status='cancelled' WHERE content_type='demand_gen_ext' AND content_id=? AND status='draft'`,
        args: [c.sku],
      });

      await addToQueue({
        contentType: "demand_gen_ext",
        contentId: c.sku,
        platform: "facebook",
        payload: JSON.stringify({ sku: c.sku, productName: frTitle, blobUrl: url, ratio: "9:16", durationSec: DURATION_SEC }),
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
  console.log(`\n=== ok=${ok} fail=${fail} needsRegen=${needsRegen} ===`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
