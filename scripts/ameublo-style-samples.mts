/**
 * Studio Ameublo — render sample videos of each Ameublo STYLE for review in /ameublo.
 *
 * Free: our own SVG + sharp + ffmpeg, no AI call. Each video goes to Blob and into
 * `ameublo_test_videos` (series "Style : <name>"), never into publication_queue.
 *
 *   node-x64 --env-file=../aosom-sync/.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/ameublo-style-samples.mts [--styles reaction,vitrine,…] [--stills DIR] [--apply]
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
const ALL = ["reaction", "vitrine", "astuce", "devine", "ab", "top3", "piece"] as const;
type Style = (typeof ALL)[number];
const STYLES = (flag("--styles")?.split(",") ?? [...ALL]) as Style[];
const SERIES_SUFFIX = flag("--suffix") ?? "";
const ROOT = process.env.SEQ_ASSETS_ROOT || path.resolve("../aosom-sync");
const FFMPEG = process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const audio = (f: string) => path.join(ROOT, "src/audio", f);
const MUSIC: Record<Style, string> = {
  reaction: audio("mixkit-pop-250.mp3"),
  vitrine: audio("mixkit-funk-1140.mp3"),
  astuce: audio("joyinsound-no-copyright-chill-music-403411.mp3"),
  devine: audio("mixkit-golden-storm-470.mp3"),
  ab: audio("mixkit-pop-250.mp3"),
  top3: audio("mixkit-funk-1140.mp3"),
  piece: audio("mixkit-lounge-695.mp3"),
};
const LABEL: Record<Style, string> = {
  reaction: "Réaction",
  vitrine: "Vitrine",
  astuce: "Astuce d’Ameublo",
  devine: "Devine le prix",
  ab: "Tu prends lequel ?",
  top3: "Top 3",
  piece: "La pièce en 4 articles",
};

/** Samples per style: varied categories, campaigns and (for Réaction) copy variants. */
const SAMPLES: Record<Style, { skus: string[]; campaign: string; room?: string }[]> = {
  reaction: [
    { skus: ["838-212WT"], campaign: "automne-2026" },
    { skus: ["370-082WT"], campaign: "enfants-2026" },
    { skus: ["D00-098BU"], campaign: "animaux-2026" },
    { skus: ["83B-059V02BG"], campaign: "maison-2026" },
  ],
  vitrine: [
    { skus: ["839-622V00CW"], campaign: "maison-2026" },
    { skus: ["833-894V80WT"], campaign: "maison-2026" },
  ],
  astuce: [
    { skus: ["836-317V01"], campaign: "automne-2026" },
    { skus: ["830-761V81GN"], campaign: "noel-2026" },
  ],
  devine: [
    { skus: ["839-622V00CW"], campaign: "maison-2026" },
    { skus: ["370-150RD"], campaign: "enfants-2026" },
  ],
  ab: [
    { skus: ["833-894V80WT", "839-135WT"], campaign: "maison-2026" },
    { skus: ["838-467V00CW", "838-603V00BK"], campaign: "automne-2026" },
  ],
  top3: [
    { skus: ["838-006V80GY", "839-281", "833-894V80WT"], campaign: "maison-2026" },
    { skus: ["311-053V00PK", "311-048GY", "3D0-008"], campaign: "enfants-2026" },
  ],
  piece: [
    { skus: ["839-622V00CW", "833-894V80WT", "839-281", "838-006V80GY"], campaign: "maison-2026", room: "salon" },
    { skus: ["836-317V01", "921-481GN", "833-450", "831-740V00GD"], campaign: "automne-2026", room: "bureau" },
  ],
};

const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);

async function main() {
  console.log(`\n🪑 Styles Ameublo — ${STYLES.join(", ")} — ${STILLS ? `STILLS → ${STILLS}` : APPLY ? "APPLY" : "DRY-RUN"}\n`);
  for (const st of STYLES) for (const s of SAMPLES[st] ?? []) console.log(`  ${LABEL[st].padEnd(20)} ${s.skus.join(" + ").padEnd(40)} ${s.campaign}`);
  if (!APPLY && !STILLS) return;

  const scenes = interop(await import("@/lib/video-engines/ameublo-scenes"));
  const sprite = interop(await import("@/lib/ameublo-sprite"));
  const copy = interop(await import("@/lib/ameublo-copy"));
  const sel = interop(await import("@/lib/selectors/by-skus"));
  const audit = interop(await import("@/lib/image-compliance-audit"));
  const db = interop(await import("@/lib/database"));
  const sharp = (await import("sharp")).default;
  const { put } = await import("@vercel/blob");
  const turso = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });

  const allSkus = [...new Set(STYLES.flatMap((st) => (SAMPLES[st] ?? []).flatMap((s) => s.skus)))];
  const products = await sel.productsBySkus(allSkus, { language: "fr", resolveImages: true });
  const bySku = new Map(products.map((p) => [String(p.sku), p]));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ameublo-styles-"));
  const download = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status} ${url}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const productOf = (sku: string) => {
    const p = bySku.get(sku);
    return { sku, title: String(p?.title_fr || sku), price: p?.price ?? null, productType: p?.product_type ?? null };
  };
  /**
   * Photos, white-background shot FIRST: Aosom's image1 always shows the whole piece
   * (Mat: "tu ne vois pas le meuble correctement" on a close-up lifestyle crop).
   */
  const photosOf = async (sku: string, n: number): Promise<Buffer[]> => {
    const row = (await turso.execute({
      sql: "SELECT image1, image2, image3, image4, image5, image6, image7 FROM products WHERE sku = ?", args: [sku],
    })).rows[0];
    const first = row?.image1 == null ? "" : String(row.image1);
    const others = [...(bySku.get(sku)?.images ?? []), ...[2, 3, 4, 5, 6, 7].map((i) => row?.[`image${i}`])]
      .map((u) => (u == null ? "" : String(u))).filter(Boolean);
    // Beyond the white-background shot, only photos the vision audit marked clean: Aosom's
    // gallery mixes in English marketing text and dimension diagrams.
    const stems = [...new Set(others.map((u) => audit.imageUrlStem(u)))];
    const clean = new Set<string>();
    if (stems.length) {
      const r = await turso.execute({
        sql: `SELECT url_stem FROM image_classifications WHERE compliant = 1 AND url_stem IN (${stems.map(() => "?").join(",")})`,
        args: stems,
      });
      for (const x of r.rows) clean.add(String(x.url_stem));
    }
    const seen = new Set<string>();
    const unique = [first, ...others.filter((u) => clean.has(audit.imageUrlStem(u)))]
      .filter((u) => u && !seen.has(audit.imageUrlStem(u)) && seen.add(audit.imageUrlStem(u)))
      .slice(0, n);
    if (!unique.length) throw new Error(`no images for ${sku}`);
    return Promise.all(unique.map(download));
  };

  try {
    for (const st of STYLES) {
      let variant = 0;
      for (const s of SAMPLES[st] ?? []) {
        const ps = s.skus.map(productOf);
        const lead = ps[0];
        const accessory = sprite.accessoryForCampaign(s.campaign);
        const lines = copy.ameubloLines(lead.sku, `${lead.productType ?? ""} ${lead.title}`, variant++);
        const tag = `${st}-${s.skus.join("_")}`;
        const out = path.join(work, `${tag}.mp4`);
        try {
          let spec;
          if (st === "reaction") {
            const clip = path.join(ROOT, "src/ugc", `${lead.sku}.mp4`);
            if (!fs.existsSync(clip)) throw new Error(`clip missing: ${clip}`);
            spec = await scenes.reactionScene(clip, lead, lines, accessory, MUSIC[st]);
          } else if (st === "vitrine") {
            spec = await scenes.vitrineScene(await photosOf(lead.sku, 4), lead, lines, accessory, MUSIC[st]);
          } else if (st === "astuce") {
            spec = await scenes.astuceScene((await photosOf(lead.sku, 1))[0], lead, lines, accessory, MUSIC[st]);
          } else if (st === "devine") {
            spec = await scenes.devinePrixScene(await photosOf(lead.sku, 4), lead, accessory, MUSIC[st]);
          } else if (st === "ab") {
            const [pa, pb] = await Promise.all(ps.map(async (p) => (await photosOf(p.sku, 1))[0]));
            spec = await scenes.ceciOuCaScene(pa, pb, ps[0], ps[1], accessory, MUSIC[st]);
          } else if (st === "piece") {
            const photos = await Promise.all(ps.map(async (p) => (await photosOf(p.sku, 1))[0]));
            spec = await scenes.pieceScene(ps.map((p, i) => ({ photo: photos[i], p })), s.room ?? "salon", accessory, MUSIC[st]);
          } else {
            const photos = await Promise.all(ps.map(async (p) => (await photosOf(p.sku, 1))[0]));
            spec = await scenes.top3Scene(ps.map((p, i) => ({ photo: photos[i], p })), accessory, MUSIC[st]);
          }

          if (STILLS) {
            fs.mkdirSync(STILLS, { recursive: true });
            const times = Array.from({ length: 6 }, (_, i) => (spec.duration * (i + 0.5)) / 6);
            const tiles: Buffer[] = [];
            for (const t of times) {
              const frame = await sharp(spec.background).composite(await spec.layersAt(t)).png().toBuffer();
              tiles.push(await sharp(frame).resize(270, 480).png().toBuffer());
            }
            await sharp({ create: { width: 280 * tiles.length, height: 480, channels: 3, background: "#ffffff" } })
              .composite(tiles.map((b, i) => ({ input: b, left: i * 280, top: 0 }))).png().toFile(path.join(STILLS, `${tag}.png`));
            console.log(`  🖼  ${tag}.png`);
            continue;
          }

          await scenes.renderScene(spec, out, FFMPEG);
          const safe = tag.replace(/[^A-Za-z0-9._-]/g, "_");
          const blob = await put(`ameublo-tests/styles/${st}/${Date.now()}-${safe}.mp4`, fs.readFileSync(out), {
            access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
          });
          const label = st === "reaction" ? `${lead.title} — « ${lines.hook} »` : ps.map((p) => p.title).join(" vs ");
          const id = await db.insertAmeubloTestVideo({
            series: `Style : ${LABEL[st]}${SERIES_SUFFIX}`, sku: s.skus.join(","), campaign: s.campaign, label, videoUrl: blob.url,
          });
          console.log(`  ✓ ${LABEL[st].padEnd(20)} ${s.skus.join(" + ").padEnd(40)} #${id}`);
        } catch (e) {
          console.error(`  ✗ ${st} ${s.skus.join(",")}: ${e instanceof Error ? e.message : String(e)}`);
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
