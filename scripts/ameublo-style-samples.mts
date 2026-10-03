/**
 * Studio Ameublo — render sample videos of each Ameublo STYLE for review in /ameublo.
 *
 * Free: our own SVG + sharp + ffmpeg, no AI call. Each video goes to Blob and into
 * `ameublo_test_videos` (series "Style : <name>"), never into publication_queue.
 *
 *   node-x64 --env-file=../aosom-sync/.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/ameublo-style-samples.mts [--styles reaction,vitrine,astuce,bumper] [--stills DIR] [--apply]
 *
 * --stills DIR  writes still frames of each sample to DIR instead of rendering (layout check).
 * Without --apply: lists the samples only. SEQ_ASSETS_ROOT = the main clone (music, UGC clips).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const STILLS = flag("--stills");
const STYLES = (flag("--styles") || "reaction,vitrine,astuce,bumper").split(",");
const ROOT = process.env.SEQ_ASSETS_ROOT || path.resolve("../aosom-sync");
const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const MUSIC = {
  reaction: path.join(ROOT, "src/audio/mixkit-pop-250.mp3"),
  vitrine: path.join(ROOT, "src/audio/mixkit-lounge-695.mp3"),
  astuce: path.join(ROOT, "src/audio/joyinsound-no-copyright-chill-music-403411.mp3"),
};
const LABEL: Record<string, string> = { reaction: "Réaction", vitrine: "Vitrine", astuce: "Astuce d’Ameublo", bumper: "Intro / Outro" };

/** Two samples per style, picked to vary category and campaign. */
const SAMPLES: Record<string, { sku: string; campaign: string }[]> = {
  reaction: [{ sku: "838-212WT", campaign: "automne-2026" }, { sku: "370-082WT", campaign: "enfants-2026" }],
  vitrine: [{ sku: "839-622V00CW", campaign: "maison-2026" }, { sku: "833-894V80WT", campaign: "maison-2026" }],
  astuce: [{ sku: "836-317V01", campaign: "automne-2026" }, { sku: "830-761V81GN", campaign: "noel-2026" }],
  bumper: [{ sku: "831-194WT", campaign: "automne-2026" }, { sku: "311-053V00PK", campaign: "enfants-2026" }],
};

const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);

async function main() {
  console.log(`\n🪑 Styles Ameublo — ${STYLES.join(", ")} — ${STILLS ? `STILLS → ${STILLS}` : APPLY ? "APPLY" : "DRY-RUN"}\n`);
  for (const st of STYLES) for (const s of SAMPLES[st] ?? []) console.log(`  ${LABEL[st].padEnd(18)} ${s.sku.padEnd(14)} ${s.campaign}`);
  if (!APPLY && !STILLS) return;

  const scenes = interop(await import("@/lib/video-engines/ameublo-scenes"));
  const sprite = interop(await import("@/lib/ameublo-sprite"));
  const sel = interop(await import("@/lib/selectors/by-skus"));
  const db = interop(await import("@/lib/database"));
  const sharp = (await import("sharp")).default;
  const { put } = await import("@vercel/blob");
  const turso = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

  const allSkus = STYLES.flatMap((st) => (SAMPLES[st] ?? []).map((s) => s.sku));
  const products = await sel.productsBySkus(allSkus, { language: "fr", resolveImages: true });
  const bySku = new Map(products.map((p) => [String(p.sku), p]));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ameublo-styles-"));
  const download = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status} ${url}`);
    return Buffer.from(await r.arrayBuffer());
  };

  try {
    for (const st of STYLES) {
      for (const s of SAMPLES[st] ?? []) {
        const p = bySku.get(s.sku);
        const product = { sku: s.sku, title: String(p?.title_fr || s.sku), price: p?.price ?? null, productType: p?.product_type ?? null };
        const accessory = sprite.accessoryForCampaign(s.campaign);
        const out = path.join(work, `${st}-${s.sku}.mp4`);
        try {
          let spec: Awaited<ReturnType<typeof scenes.reactionScene>> | null = null;
          if (st === "reaction") {
            const clip = path.join(ROOT, "src/ugc", `${s.sku}.mp4`);
            if (!fs.existsSync(clip)) throw new Error(`clip missing: ${clip}`);
            spec = await scenes.reactionScene(clip, product, accessory, MUSIC.reaction);
          } else if (st === "vitrine") {
            const imgs = (p?.images ?? []).slice(0, 3);
            if (!imgs.length) throw new Error("no images");
            spec = await scenes.vitrineScene(await Promise.all(imgs.map(download)), product, accessory, MUSIC.vitrine);
          } else if (st === "astuce") {
            const img = p?.images?.[0];
            if (!img) throw new Error("no image");
            spec = await scenes.astuceScene(await download(img), product, accessory, MUSIC.astuce);
          }

          if (STILLS) {
            fs.mkdirSync(STILLS, { recursive: true });
            const specs = st === "bumper" ? [await scenes.bumperIntro(accessory), await scenes.bumperOutro(accessory)] : [spec!];
            const tiles: Buffer[] = [];
            for (const sp of specs) {
              const times = st === "bumper" ? [sp.duration * 0.4, sp.duration * 0.9] : [0.3, 1.5, 4.5, 7.5, 10.5].filter((t) => t < sp.duration);
              for (const t of times) {
                const frame = await sharp(sp.background).composite(await sp.layersAt(t)).png().toBuffer();
                tiles.push(await sharp(frame).resize(270, 480).png().toBuffer());
              }
            }
            await sharp({ create: { width: 280 * tiles.length, height: 480, channels: 3, background: "#ffffff" } })
              .composite(tiles.map((b, i) => ({ input: b, left: i * 280, top: 0 }))).png().toFile(path.join(STILLS, `${st}-${s.sku}.png`));
            console.log(`  🖼  ${st}-${s.sku}.png`);
            continue;
          }

          if (st === "bumper") {
            const r = await turso.execute({
              sql: `SELECT payload FROM publication_queue WHERE content_type='sequential_ad' AND status='draft' AND content_id LIKE ? LIMIT 1`,
              args: [`%:${s.sku}`],
            });
            const url = r.rows[0] ? JSON.parse(String(r.rows[0].payload)).reelsVideoUrl : null;
            if (!url) throw new Error("no source ad");
            const ad = path.join(work, `ad-${s.sku}.mp4`);
            fs.writeFileSync(ad, await download(url));
            const intro = path.join(work, `intro-${s.sku}.mp4`);
            const outro = path.join(work, `outro-${s.sku}.mp4`);
            await scenes.renderScene(await scenes.bumperIntro(accessory), intro, FFMPEG);
            await scenes.renderScene(await scenes.bumperOutro(accessory), outro, FFMPEG);
            await scenes.concatClips([intro, ad, outro], out, FFMPEG);
          } else {
            await scenes.renderScene(spec!, out, FFMPEG);
          }

          const safe = s.sku.replace(/[^A-Za-z0-9._-]/g, "_");
          const blob = await put(`ameublo-tests/styles/${st}/${Date.now()}-${safe}.mp4`, fs.readFileSync(out), {
            access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
          });
          const id = await db.insertAmeubloTestVideo({
            series: `Style : ${LABEL[st]}`, sku: s.sku, campaign: s.campaign, label: product.title, videoUrl: blob.url,
          });
          console.log(`  ✓ ${LABEL[st].padEnd(18)} ${s.sku.padEnd(14)} #${id}`);
        } catch (e) {
          console.error(`  ✗ ${st} ${s.sku}: ${e instanceof Error ? e.message : String(e)}`);
        }
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
