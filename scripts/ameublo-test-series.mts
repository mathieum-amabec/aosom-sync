/**
 * Studio Ameublo — render a series of mascot TEST videos for review in /ameublo.
 *
 * Takes already-rendered sequential-ad drafts (varied campaigns), lays the "Ameublo présente"
 * overlay on them (free: our own SVG + ffmpeg, no AI call), uploads each result to Blob and
 * records it in `ameublo_test_videos`. Nothing is published: that table never feeds
 * publication_queue, and the source drafts are left untouched.
 *
 *   node-x64 --env-file=../aosom-sync/.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/ameublo-test-series.mts [--series "Série 1 — constance"] [--per-campaign 2] [--apply]
 *
 * Dry-run by default (prints the selection only).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const SERIES = flag("--series") || `Série ${new Date().toISOString().slice(0, 10)}`;
const PER_CAMPAIGN = Number(flag("--per-campaign") || 2);
const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const FONT = process.env.SEQ_FONT || "fonts/DMSans.ttf";
const BAR_H = 170;

// tsx emits CJS for these modules, so named exports can arrive on `default`.
const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);

interface Source { id: number; sku: string; campaign: string; style: string; url: string; title: string }

async function pickSources(): Promise<Source[]> {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO vars missing (run with --env-file=…/.env.local)");
  const db = createClient({ url, authToken });
  const r = await db.execute(
    `SELECT id, content_id, payload, metadata FROM publication_queue
     WHERE content_type = 'sequential_ad' AND status = 'draft' ORDER BY content_id`,
  );
  const byCampaign = new Map<string, Source[]>();
  for (const row of r.rows) {
    const [, style, campaign, ...rest] = String(row.content_id).split(":");
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(String(row.payload)); } catch { /* skip */ }
    const videoUrl = typeof payload.reelsVideoUrl === "string" ? payload.reelsVideoUrl : null;
    if (!videoUrl) continue;
    const list = byCampaign.get(campaign) ?? [];
    list.push({
      id: Number(row.id),
      sku: rest.join(":"),
      campaign,
      style,
      url: videoUrl,
      title: String(payload.caption ?? "").split("\n")[0].slice(0, 70),
    });
    byCampaign.set(campaign, list);
  }
  // Spread across each campaign (first, middle, …) rather than the first N alphabetically.
  const out: Source[] = [];
  for (const list of byCampaign.values()) {
    const step = Math.max(1, Math.floor(list.length / PER_CAMPAIGN));
    for (let i = 0; i < list.length && out.filter((s) => s.campaign === list[0].campaign).length < PER_CAMPAIGN; i += step) {
      out.push(list[i]);
    }
  }
  return out;
}

/**
 * Where the ad's copy sits: the composer darkens the text band with a gradient, so the darker
 * of the two bands is the copy. Ameublo takes the other half.
 */
function copyIsAtTop(file: string): boolean {
  const res = spawnSync(FFMPEG, ["-v", "error", "-ss", "6", "-i", file, "-frames:v", "1",
    "-vf", "scale=108:192,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  const px = res.stdout as Buffer;
  if (!px || px.length < 108 * 192) return false;
  const band = (y0: number, y1: number) => {
    let sum = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < 108; x++) sum += px[y * 108 + x];
    return sum / ((y1 - y0) * 108);
  };
  // Bands from video-ad-composer textBand(): top 210-610, bottom 1250-1660 (÷10 here).
  return band(21, 61) + 12 < band(125, 166);
}

async function main() {
  const sources = await pickSources();
  console.log(`\n🪑 Studio Ameublo — ${SERIES} — ${sources.length} vidéo(s) — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  for (const s of sources) console.log(`  q${s.id}  ${s.campaign.padEnd(14)} ${s.sku.padEnd(14)} ${s.title}`);
  if (!APPLY) return;

  const overlay = interop(await import("@/lib/video-engines/ameublo-overlay"));
  const sprite = interop(await import("@/lib/ameublo-sprite"));
  const db = interop(await import("@/lib/database"));
  const { put } = await import("@vercel/blob");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ameublo-series-"));
  const slug = SERIES.normalize("NFD").replace(/[^\w-]+/g, "-").toLowerCase();
  try {
    for (const s of sources) {
      const safe = s.sku.replace(/[^A-Za-z0-9._-]/g, "_");
      const src = path.join(work, `${safe}.mp4`);
      const out = path.join(work, `${safe}.ameublo.mp4`);
      try {
        const res = await fetch(s.url);
        if (!res.ok) throw new Error(`download ${res.status}`);
        fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
        const top = copyIsAtTop(src);
        await overlay.applyAmeubloOverlay(src, out, {
          ffmpegBin: FFMPEG,
          fontFile: FONT,
          bubbleText: sprite.bubbleLineFor(s.sku),
          accessory: sprite.accessoryForCampaign(s.campaign),
          vertical: top ? "bottom" : "top",
          bottomMargin: BAR_H,
        });
        const blob = await put(`ameublo-tests/${slug}/${Date.now()}-${safe}.mp4`, fs.readFileSync(out), {
          access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
        });
        const id = await db.insertAmeubloTestVideo({
          series: SERIES, sku: s.sku, campaign: s.campaign, label: s.title, videoUrl: blob.url, sourceQueueId: s.id,
        });
        console.log(`  ✓ ${s.sku.padEnd(14)} #${id}  (${top ? "texte en haut → Ameublo en bas" : "Ameublo en haut"})`);
      } catch (e) {
        console.error(`  ✗ ${s.sku}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
