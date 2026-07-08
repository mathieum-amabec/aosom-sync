#!/usr/bin/env tsx
/**
 * scripts/render-sequential-ads.mts
 *
 * Renders "sequential ad" videos (4 sequential FR messages, patio/été campaign) and
 * enqueues them as publication_queue drafts with content_type='sequential_ad' +
 * metadata {style, campaign}. Two styles:
 *
 *   --style hero         Module A hero-slides: the 4 messages full-bleed over a patio
 *                        product's cdn.shopify photos (top-N patio by 14d velocity,
 *                        filtered to the Shopify `lifestyle-verified` tag at run time).
 *   --style demand-gen   4 messages timed over a real live-action product clip
 *                        (src/{sku}.mp4), for the patio SKUs that have a clip.
 *
 * Uploads each MP4 to the PUBLIC Vercel Blob store under slideshows/sequential-ads/,
 * then enqueues a status='draft' row (approve in /sequential-ads to schedule; the
 * existing hourly publisher drains it). Dry-run by default; --apply renders + writes.
 *
 * Run from the MAIN clone under x64 Node with prod creds + WinGet ffmpeg. src/audio +
 * the demand-gen clips (src/{sku}.mp4) are gitignored but present in the main clone, so
 * MUSIC + CLIP_DIR default there — only FFMPEG_BIN is needed (SEQ_MUSIC / SEQ_CLIP_DIR
 * override only if the assets live elsewhere):
 *
 *   FFMPEG_BIN="…/ffmpeg.exe" \
 *   node-x64 --env-file=C:\\Users\\vente\\Documents\\aosom-sync\\.env.local \
 *     node_modules/tsx/dist/cli.mjs scripts/render-sequential-ads.mts --style hero --campaign patio-ete-2026 --limit 10 --apply
 */
import path from "path";
import fs from "fs";
import { spawn, execFileSync } from "child_process";
import { createClient } from "@libsql/client";

// ── CLI ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply") && !argv.includes("--dry-run");
const flag = (name: string): string | null => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1) || null;
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const STYLE = (flag("--style") ?? "hero") as "hero" | "demand-gen";
if (STYLE !== "hero" && STYLE !== "demand-gen") {
  console.error("Invalid --style. Use --style hero | --style demand-gen"); process.exit(1);
}
const CAMPAIGN = flag("--campaign") ?? "patio-ete-2026";
const LIMIT = flag("--limit") ? Number(flag("--limit")) : STYLE === "hero" ? 50 : 12;

const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const MUSIC = process.env.SEQ_MUSIC || path.resolve(process.cwd(), "src/audio/sigmamusicart-no-copyright-music-514564.mp3");
// Demand-gen source clips live in the MAIN clone's src/{sku}.mp4 (gitignored; the
// -WEB-NT no-text clips downloaded there). Override with SEQ_CLIP_DIR if elsewhere.
const CLIP_DIR = process.env.SEQ_CLIP_DIR || "src";
const FONT = process.env.SEQ_FONT || "fonts/DMSans.ttf";
const NAVY = "0x1A2340";

const MESSAGES = [
  "GRANDE LIQUIDATION DE MOBILIER D'EXTÉRIEUR",
  "À PRIX IMBATTABLES",
  "LIVRAISON GRATUITE AU CANADA",
  "MAGASINEZ SUR AMEUBLODIRECT.CA",
];
const BRAND = "ameublo" as const;

// ── dynamic engine imports (circular-graph safe under tsx) ────────────────
type Lib = Awaited<ReturnType<typeof loadLib>>;
async function loadLib() {
  const [ren, vbt, ic, val, bsk, rbf, dbM, schedM] = await Promise.all([
    import("@/lib/slideshow/render"),
    import("@/lib/video-brand-tokens"),
    import("@/lib/image-composer"),
    import("@/lib/slideshow/validate"),
    import("@/lib/selectors/by-skus"),
    import("@/lib/register-brand-fonts"),
    import("@/lib/database"),
    import("@/lib/publication-scheduler"),
  ]);
  rbf.registerBrandFonts();
  return {
    ratioDimensions: ren.ratioDimensions,
    buildXfadeFilterComplex: ren.buildXfadeFilterComplex,
    VIDEO_BRAND: vbt.VIDEO_BRAND,
    downloadImage: ic.downloadImage,
    isShopifyCdnUrl: val.isShopifyCdnUrl,
    productsBySkus: bsk.productsBySkus,
    addToQueue: dbM.addToQueue,
    getOccupiedQueueSlots: dbM.getOccupiedQueueSlots,
    getSetting: dbM.getSetting,
    getNextAvailableSlot: schedM.getNextAvailableSlot,
    parseVideoSchedule: schedM.parseVideoSchedule,
  };
}

// ── prod Turso (velocity + lifestyle-verified) ───────────────────────────
function direct() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing (run with --env-file=…/.env.local)");
  return createClient({ url, authToken });
}
const PATIO = `(products.product_type LIKE '%Patio%' OR products.product_type LIKE '%Outdoor%' OR products.product_type LIKE '%Garden%' OR products.product_type LIKE '%Pool%')`;

/** Patio SKUs ordered by 14d stock-depletion velocity (mirrors bestSellers, patio-scoped). */
async function patioByVelocity(limit: number): Promise<string[]> {
  const res = await direct().execute({
    sql: `SELECT products.sku, SUM(ph.old_qty - ph.new_qty) AS velocity14d
          FROM price_history ph JOIN products ON products.sku = ph.sku
          WHERE ph.change_type='stock_change'
            AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
            AND ph.old_qty > ph.new_qty
            AND products.shopify_product_id IS NOT NULL AND products.shopify_product_id != ''
            AND ${PATIO}
          GROUP BY products.sku ORDER BY velocity14d DESC LIMIT ?`,
    args: [limit * 3], // over-fetch; lifestyle-verified + image filters trim it
  });
  return res.rows.map((r) => String((r as Record<string, unknown>).sku));
}

/** Patio SKUs that have a src/{sku}.mp4 clip available (for demand-gen). */
async function patioClipSkus(): Promise<string[]> {
  let clips: string[] = [];
  try { clips = fs.readdirSync(CLIP_DIR).filter((f) => f.endsWith(".mp4")).map((f) => f.replace(/\.mp4$/, "")); } catch {}
  if (clips.length === 0) return [];
  const placeholders = clips.map(() => "?").join(",");
  const res = await direct().execute({
    sql: `SELECT products.sku FROM products
          WHERE products.shopify_product_id IS NOT NULL AND products.shopify_product_id != ''
            AND ${PATIO} AND products.sku IN (${placeholders})`,
    args: clips,
  });
  return res.rows.map((r) => String((r as Record<string, unknown>).sku));
}

/** All Shopify `lifestyle-verified` variant SKUs (paginated). */
async function lifestyleVerifiedSkus(): Promise<Set<string>> {
  const store = "27u5y2-kp.myshopify.com";
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const ver = process.env.SHOPIFY_API_VERSION || "2024-10";
  const out = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const after: string = cursor ? `, after: "${cursor}"` : "";
    const r = await fetch(`https://${store}/admin/api/${ver}/graphql.json`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token ?? "" },
      body: JSON.stringify({ query: `{ products(first: 250, query: "tag:'lifestyle-verified'"${after}) { pageInfo { hasNextPage endCursor } nodes { variants(first: 20) { nodes { sku } } } } }` }),
    });
    const j = await r.json() as { data?: { products?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { variants: { nodes: { sku: string | null }[] } }[] } }; errors?: unknown };
    const p = j.data?.products;
    if (!p) throw new Error(`Shopify lifestyle-verified query failed: ${JSON.stringify(j.errors)}`);
    for (const n of p.nodes) for (const v of n.variants.nodes) if (v.sku) out.add(String(v.sku));
    if (!p.pageInfo.hasNextPage) break;
    cursor = p.pageInfo.endCursor;
    await new Promise((res) => setTimeout(res, 600));
  }
  return out;
}

// ── text overlay (brand hero style, auto-fit so long FR lines never clip) ──
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function wrap(text: string, maxPerLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = []; let cur = "";
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (cur && next.length > maxPerLine) {
      lines.push(cur);
      if (lines.length === maxLines - 1) { cur = words.slice(i).join(" "); break; }
      cur = words[i];
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
function fitFont(lines: string[]): number {
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest <= 12) return 100;
  if (longest <= 16) return 86;
  if (longest <= 20) return 72;
  if (longest <= 26) return 60;
  return 52;
}
const up = (s: string) => s.toLocaleUpperCase("fr-CA");

function heroSvg(text: string, dims: { width: number; height: number }, lib: Lib): string {
  const { navy, gold, offWhite } = lib.VIDEO_BRAND.colors;
  const font = lib.VIDEO_BRAND.font.family;
  const lines = wrap(up(text), 18, 4);
  const fs = fitFont(lines);
  const gap = Math.round(fs * 1.18);
  const cx = dims.width / 2, cy = dims.height / 2;
  const top = cy - ((lines.length - 1) * gap) / 2;
  const parts = [`<rect x="0" y="0" width="${dims.width}" height="${dims.height}" fill="${navy}" opacity="0.42"/>`];
  lines.forEach((ln, i) => parts.push(
    `<text x="${cx}" y="${top + i * gap}" font-family="${font},Arial,sans-serif" font-size="${fs}" font-weight="${lib.VIDEO_BRAND.font.titleWeight}" fill="${offWhite}" text-anchor="middle" stroke="${navy}" stroke-width="3" paint-order="stroke">${escapeXml(ln)}</text>`,
  ));
  parts.push(`<rect x="${cx - 130}" y="${top + lines.length * gap - Math.round(gap * 0.35)}" width="260" height="8" fill="${gold}"/>`);
  return `<svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

// ── render helpers ────────────────────────────────────────────────────────
function runFfmpegSpawn(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; proc.stderr.on("data", (c) => { err += c.toString(); if (err.length > 8000) err = err.slice(-8000); });
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-800)}`))));
  });
}

const FPS = 30, PER_SLIDE = 4.0, XFADE = 0.4;

/** Style A: 4 hero messages over up to 4 cdn.shopify photos of one product. */
async function renderHero(images: string[], outFile: string, lib: Lib): Promise<void> {
  const sharp = (await import("sharp")).default;
  const dims = lib.ratioDimensions("9:16");
  const navyHex = lib.VIDEO_BRAND.colors.navy;
  const n = MESSAGES.length;
  const pics = Array.from({ length: n }, (_, i) => images[i % images.length]); // cycle if <4 angles
  const durations = Array.from({ length: n }, () => PER_SLIDE);
  const totalSec = n * PER_SLIDE - (n - 1) * XFADE;
  const workDir = fs.mkdtempSync(path.join(process.env.TEMP || ".", "seqhero-"));
  try {
    const photos: string[] = [], texts: string[] = [];
    for (let i = 0; i < n; i++) {
      const pp = path.join(workDir, `p${i}.png`), tp = path.join(workDir, `t${i}.png`);
      try {
        const buf = await lib.downloadImage(pics[i]);
        await sharp(buf).resize(dims.width, dims.height, { fit: "cover" }).png().toFile(pp);
      } catch {
        await sharp({ create: { width: dims.width, height: dims.height, channels: 3, background: navyHex } }).png().toFile(pp);
      }
      await sharp(Buffer.from(heroSvg(MESSAGES[i], dims, lib))).png().toFile(tp);
      photos.push(pp); texts.push(tp);
    }
    const { filterComplex, videoLabel, audioLabel } = lib.buildXfadeFilterComplex({
      count: n, durations, dims, fps: FPS, xfadeSec: XFADE, hasMusic: true, musicVolumeDb: lib.VIDEO_BRAND.music.volume, totalSec,
    });
    const args = ["-loglevel", "error"];
    photos.forEach((p, i) => args.push("-loop", "1", "-t", String(durations[i]), "-i", p));
    texts.forEach((t, i) => args.push("-loop", "1", "-t", String(durations[i]), "-i", t));
    args.push("-i", MUSIC, "-filter_complex", filterComplex, "-map", `[${videoLabel}]`);
    if (audioLabel) args.push("-map", `[${audioLabel}]`);
    args.push("-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-t", String(totalSec));
    if (audioLabel) args.push("-c:a", "aac", "-b:a", "128k");
    args.push("-movflags", "+faststart", "-y", outFile);
    await runFfmpegSpawn(args);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Style B: 4 timed messages over a live-action clip (blurred-fill 9:16). */
function renderDemandGen(sku: string, outFile: string): void {
  const W = 1080, H = 1920, effDur = 15, seg = effDur / MESSAGES.length;
  const src = `${CLIP_DIR}/${sku}.mp4`;
  if (!fs.existsSync(src)) throw new Error(`clip missing: ${src}`);
  // drawtext `textfile=` must be a RELATIVE forward-slash path: an absolute Windows
  // path (C:\…) makes ffmpeg's filtergraph parser treat ':' and '\' as option
  // separators and fail with "No option name near …". Keep it under cwd.
  const lineDir = `tmp_seqdg/${sku.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  fs.mkdirSync(lineDir, { recursive: true });
  try {
    const base =
      `[0:v]split=2[a][b];` +
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,setsar=1[bg];` +
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
    const draws: string[] = [];
    MESSAGES.forEach((msg, m) => {
      const start = m * seg, end = (m + 1) * seg;
      const lines = wrap(up(msg), 18, 4);
      const fsz = fitFont(lines), spacing = Math.round(fsz * 1.25), bw = Math.max(2, Math.round(fsz * 0.06));
      const topY = Math.round(H / 2 - ((lines.length - 1) * spacing) / 2);
      lines.forEach((ln, i) => {
        const file = `${lineDir}/m${m}_l${i}.txt`;
        fs.writeFileSync(file, ln, "utf8");
        const alpha = `alpha='min(1\\,max(0\\,(t-${start.toFixed(2)})/0.4))'`;
        const enable = `enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`;
        draws.push(`drawtext=fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${fsz}:borderw=${bw}:bordercolor=${NAVY}:shadowcolor=black@0.7:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${topY + i * spacing}:${enable}:${alpha}`);
      });
    });
    const fadeOut = Math.max(0, effDur - 0.5).toFixed(3);
    const videoGraph = `${base};[base]${draws.join(",")},fade=t=in:d=0.5,fade=t=out:st=${fadeOut}:d=0.5[vout]`;
    const audioGraph = `[1:a]volume=0.25,afade=t=in:d=1,afade=t=out:st=${Math.max(0, effDur - 1).toFixed(3)}:d=1[aout]`;
    const args = [
      "-y", "-nostdin", "-loglevel", "error", "-ss", "3", "-i", src,
      "-stream_loop", "-1", "-i", MUSIC, "-t", String(effDur),
      "-filter_complex", `${videoGraph};${audioGraph}`, "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outFile,
    ];
    execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    fs.rmSync(lineDir, { recursive: true, force: true });
  }
}

// ── enqueue ────────────────────────────────────────────────────────────────
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

const STYLE_KEY = STYLE === "hero" ? "hero_slides" : "demand_gen_messages";

async function uploadBlob(localFile: string, sku: string): Promise<string> {
  const { put } = await import("@vercel/blob");
  // Sanitize the sku in the key (defense in depth; a '/' would reshape the Blob path).
  const safeSku = sku.replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `slideshows/sequential-ads/${STYLE}/${CAMPAIGN}/${Date.now()}-${safeSku}.mp4`;
  const buf = await fs.promises.readFile(localFile);
  const blob = await put(key, buf, { access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true });
  return blob.url;
}

/**
 * Reserve a tentative slot for this sku BEFORE uploading, so a slotless run never
 * strands a blob with no queue row. Cancels any prior UNAPPROVED draft for this
 * sku/style/campaign first (never an approved 'pending' post) — mirrors the batch,
 * and frees that slot for reuse. Returns null when the schedule has no free slot.
 */
async function pickSlot(lib: Lib, sku: string, occupied: number[]): Promise<{ contentId: string; sqlite: string; at: number } | null> {
  const contentId = `seqad:${STYLE_KEY}:${CAMPAIGN}:${sku}`;
  await direct().execute({
    sql: `UPDATE publication_queue SET status='cancelled'
          WHERE content_type='sequential_ad' AND content_id=? AND status='draft'`,
    args: [contentId],
  });
  const videoSchedule = lib.parseVideoSchedule(await lib.getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const slot = await lib.getNextAvailableSlot("facebook", {}, { nowSec, occupied, schedule: videoSchedule, contentType: "sequential_ad" });
  if (!slot) return null;
  return { contentId, sqlite: slot.sqlite, at: slot.at };
}

/** Insert the draft row for an already-reserved slot + uploaded blob. */
async function insertDraft(lib: Lib, slot: { contentId: string; sqlite: string; at: number }, caption: string, blobUrl: string, occupied: number[]): Promise<number> {
  const queueId = await lib.addToQueue({
    contentType: "sequential_ad",
    contentId: slot.contentId,
    platform: "both",
    payload: JSON.stringify({ caption, brand: BRAND, reelsVideoUrl: blobUrl }),
    scheduledAt: slot.sqlite,
    status: "draft",
    metadata: { style: STYLE_KEY, campaign: CAMPAIGN },
  });
  occupied.push(slot.at); // so the next draft picks a distinct slot
  return queueId;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n🎬 Sequential ads — style=${STYLE} campaign=${CAMPAIGN} limit=${LIMIT} — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  const lib = await loadLib();
  if (APPLY && !fs.existsSync(MUSIC)) throw new Error(`music not found: ${MUSIC} (set SEQ_MUSIC to the main clone's absolute path)`);

  // Selection
  const lvSkus = await lifestyleVerifiedSkus();
  console.log(`lifestyle-verified SKUs on Shopify: ${lvSkus.size}`);
  let skus: string[];
  if (STYLE === "hero") {
    const ranked = await patioByVelocity(LIMIT);
    skus = ranked.filter((s) => lvSkus.has(s)).slice(0, LIMIT);
    console.log(`patio-by-velocity (∩ lifestyle-verified): ${skus.length} SKUs`);
  } else {
    const clips = await patioClipSkus();
    // Same quality gate as hero: only advertise lifestyle-verified products.
    const verified = clips.filter((s) => lvSkus.has(s));
    skus = verified.slice(0, LIMIT);
    console.log(`patio clips: ${clips.length}, of which lifestyle-verified: ${verified.length} → using ${skus.length}`);
  }

  // Resolve titles + (hero) cdn.shopify images
  const products = await lib.productsBySkus(skus, { language: "fr", resolveImages: STYLE === "hero" });
  const bySku = new Map(products.map((p) => [String(p.sku), p]));

  const report: { sku: string; title: string; images?: number; queueId?: number; slot?: string; status: string }[] = [];
  const OUT_TMP = fs.mkdtempSync(path.join(process.env.TEMP || ".", "seqout-"));
  // Seed occupancy from already-scheduled sequential-ad slots so new drafts don't
  // pick a tentative slot that collides with a previously-approved pending post.
  const occupied = APPLY
    ? (await lib.getOccupiedQueueSlots("both", "sequential_ad")).map(sqliteToUnixSec)
    : [];

  try {
    for (const sku of skus) {
      const p = bySku.get(sku);
      const title = (p?.title_fr || p?.title_en || sku) as string;
      try {
        // Render locally first, THEN reserve a slot, THEN upload — so a slotless run
        // never leaves a blob in the store with no queue row pointing at it.
        const out = path.join(OUT_TMP, `${sku.replace(/[^A-Za-z0-9._-]/g, "_")}.mp4`);
        let images: number | undefined;
        if (STYLE === "hero") {
          const imgs = (p?.images || []).filter(lib.isShopifyCdnUrl);
          images = imgs.length;
          if (imgs.length === 0) { report.push({ sku, title, images: 0, status: "skip (no cdn.shopify image)" }); continue; }
          if (!APPLY) { report.push({ sku, title, images: imgs.length, status: "dry-run" }); continue; }
          await renderHero(imgs.slice(0, 4), out, lib);
        } else {
          if (!APPLY) { report.push({ sku, title, status: "dry-run" }); continue; }
          renderDemandGen(sku, out);
        }
        const slot = await pickSlot(lib, sku, occupied);
        if (!slot) {
          report.push({ sku, title, images, status: "rendered (no slot)" });
        } else {
          const url = await uploadBlob(out, sku);
          const queueId = await insertDraft(lib, slot, title, url, occupied);
          report.push({ sku, title, images, queueId, slot: slot.sqlite, status: "draft" });
        }
        console.log(`  ✓ ${sku.padEnd(14)} ${report[report.length - 1].status.padEnd(20)} ${title}`);
      } catch (err) {
        report.push({ sku, title, status: `error: ${err instanceof Error ? err.message : String(err)}` });
        console.error(`  ✗ ${sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    fs.rmSync(OUT_TMP, { recursive: true, force: true });
    fs.rmSync("tmp_seqdg", { recursive: true, force: true }); // demand-gen line files
  }

  console.log(`\n=== RÉCAP (${report.length}) — style=${STYLE} ===`);
  for (const r of report) console.log(`${r.sku.padEnd(14)} q=${String(r.queueId ?? "-").padEnd(5)} ${r.status.padEnd(22)} ${r.title}`);
  if (!APPLY) console.log(`\nDry-run. Re-run with --apply to render + upload + enqueue drafts.`);
  else console.log(`\nApprouve les brouillons dans /sequential-ads.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error("\nFATAL:", err); process.exit(1); });
