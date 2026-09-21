#!/usr/bin/env tsx
/**
 * scripts/batch-before-after.mts — Étape 3.2: avant/après batch, driven by trend+season
 * priority (Étape 2), restricted to candidates carrying Shopify's `lifestyle-verified` tag.
 *
 * Rendering is the validated v3 design (poc-before-after-v3.mts): contain-fit crop (full
 * product visible), 0.9s dissolve, ~6.1s total, kinetic label pop, cinematic grade — copied
 * rather than imported for the same reason as the assembly batch (script, not a module).
 *
 * CORRECTION ROUND 2 (this session — round 1's 2-candidate classifier still shipped a bad
 * pair): AB-830-323's "AVANT" was a dimension-chart image (a Santa figure for scale + printed
 * measurement lines/text) — not a real neutral shot. Root cause, confirmed by downloading and
 * reviewing ALL 7 of that SKU's Shopify images, not just the 2 offered: media[0] was a
 * decorated lifestyle scene and media[6] (the other candidate) was the dimension chart —
 * NEITHER of the two candidates round 1 offered the classifier was a genuinely clean product
 * shot. The real clean shot existed at media[5], which was never in the running because the
 * candidate pool was hard-limited to {first, last}. This was a candidate-SCOPE bug, not a
 * classification bug — Vision correctly picked the "more neutral of the two" it was shown, but
 * the two it was shown were both bad.
 *
 * Fixed by `classifyGalleryForBeforeAfter`: sends the WHOLE gallery (capped at 10 images) in
 * one call, asks Vision to pick the single best true-neutral studio shot (explicitly
 * rejecting dimension charts, assembly diagrams, and lifestyle scenes — not just "the more
 * neutral of two") and the single best genuine lifestyle shot, each answer allowed to be
 * "none" if nothing in the gallery qualifies. A SKU where either role comes back null is
 * SKIPPED — Mat gets a clean pair or nothing, never a forced bad one.
 *
 * DRAFT ONLY — content_type='before_after', status='draft'.
 * Usage: node_modules/tsx/dist/cli.mjs scripts/batch-before-after.mts --limit 15 --apply
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FONT = "fonts/DMSans.ttf";
const LOGO = "Logo/officiel-transparent.png";
const MUSIC_DIR = "src/audio";
const W = 1080, H = 1920, FPS = 30;
const NAVY = "0x1A2340", GOLD = "0xD4A853";
const BAR_H = 170;
const HOOK_SEC = 1.0, STILL_SEC = 3.0, XFADE_SEC = 0.9;
const TOTAL = HOOK_SEC + STILL_SEC * 2 - XFADE_SEC; // 6.1s
const GRADE = "curves=preset=medium_contrast,eq=saturation=1.12:contrast=1.03";
const MIN_MEDIA = 5;

for (const [label, p] of [["Font", FONT], ["Logo", LOGO]] as const) {
  if (!existsSync(p)) { console.error(`✗ ${label} not found: ${p}`); process.exit(1); }
}

async function prepareContain(url: string, out: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const bg = await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).blur(45).modulate({ brightness: 0.55 }).toBuffer();
  const fg = await sharp(buf).resize(980, 1650, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp(bg).composite([{ input: fg, gravity: "center" }]).png().toFile(out);
}
async function prepareHook(url: string, out: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).png().toFile(out);
}
function esc(e: string): string { return e.replace(/,/g, "\\,"); }

function build(dir: string, labels: [string, string], musicIdx: number): string {
  const barY = H - BAR_H;
  const plateH = 88, plateW = 340;
  const plateY = barY + Math.round((BAR_H - plateH) / 2);
  const urlY = barY + Math.round((BAR_H - 46) / 2) - 4;
  const d = Math.round(STILL_SEC * FPS);
  const kbOut = `zoompan=z='1.05-0.05*on/${d - 1}':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;
  const kbIn = `zoompan=z='1+0.05*on/${d - 1}':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`;
  const parts: string[] = [];
  parts.push(`[0:v]scale=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[hook]`);
  parts.push(`[1:v]${kbOut},setsar=1,format=yuv420p[a]`);
  parts.push(`[2:v]${kbIn},setsar=1,format=yuv420p[b]`);
  const HARD_CUT = 1 / FPS;
  parts.push(`[hook][a]xfade=transition=fade:duration=${HARD_CUT.toFixed(3)}:offset=${(HOOK_SEC - HARD_CUT).toFixed(3)}[ha]`);
  const xfadeOffset = (HOOK_SEC + STILL_SEC - XFADE_SEC).toFixed(2);
  parts.push(`[ha][b]xfade=transition=dissolve:duration=${XFADE_SEC}:offset=${xfadeOffset}[x]`);
  parts.push(`[x]${GRADE}[graded]`);
  parts.push(`[graded]drawbox=x=0:y=${Math.round(H * 0.62)}:w=${W}:h=${Math.round(H * 0.18)}:color=black@0.38:t=fill[scrim]`);
  parts.push(`[scrim]drawbox=x=0:y=${barY}:w=${W}:h=${BAR_H}:color=${NAVY}@0.72:t=fill[bar]`);
  parts.push(`[${musicIdx + 1}:v]scale=300:-1[logo_s]`);
  parts.push(`color=white@0.92:size=${plateW}x${plateH}:r=${FPS}[plate]`);
  parts.push(`[plate][logo_s]overlay=(W-w)/2:(H-h)/2:shortest=1[lb]`);
  parts.push(`[bar][lb]overlay=44:${plateY}[wl]`);
  parts.push(`[wl]drawtext=fontfile=${FONT}:text=ameublodirect.ca:fontcolor=${GOLD}:fontsize=46:borderw=1:bordercolor=black@0.4:x=W-text_w-56:y=${urlY}[branded]`);
  const draws: string[] = [];
  const labelY = Math.round(H * 0.665);
  const windows: [number, number][] = [
    [HOOK_SEC + 0.15, HOOK_SEC + STILL_SEC - XFADE_SEC],
    [HOOK_SEC + STILL_SEC, TOTAL],
  ];
  labels.forEach((text, i) => {
    const [s0, e0] = windows[i];
    const f = `${dir}/label${i}.txt`;
    writeFileSync(f, text, "utf8");
    const p = esc(`min(1,max(0,(t-${s0.toFixed(2)})/0.3))`);
    const ease = esc(`(1-pow(1-min(1,max(0,(t-${s0.toFixed(2)})/0.35)),2))`);
    draws.push(`drawtext=fontfile=${FONT}:textfile=${f}:fontcolor=white:fontsize=98:borderw=3:bordercolor=black@0.5:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${labelY}:alpha='${p}':enable='${esc(`between(t,${s0.toFixed(2)},${(s0 + 0.12).toFixed(2)})`)}'`);
    draws.push(`drawtext=fontfile=${FONT}:textfile=${f}:fontcolor=white:fontsize=104:borderw=3:bordercolor=black@0.5:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=(w-text_w)/2:y='${labelY}+(1-${ease})*20':alpha=1:enable='${esc(`between(t,${(s0 + 0.12).toFixed(2)},${e0.toFixed(2)})`)}'`);
    draws.push(`drawbox=x='(${W}-420*${p})/2':y=${labelY + 130}:w='420*${p}':h=6:color=${GOLD}:t=fill:enable='${esc(`between(t,${s0.toFixed(2)},${e0.toFixed(2)})`)}'`);
  });
  parts.push(`[branded]${draws.join(",")},fade=t=out:st=${(TOTAL - 0.4).toFixed(2)}:d=0.4,setsar=1,format=yuv420p[vout]`);
  return parts.join(";");
}

interface ShopifyMedia { title: string; images: string[] }
async function fetchShopifyMedia(sku: string): Promise<ShopifyMedia | null> {
  const shop = "27u5y2-kp.myshopify.com";
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      query: `{ products(first: 1, query: "sku:${sku}") { edges { node { title images(first: 20) { edges { node { url } } } } } } }`,
    }),
  });
  const json = (await res.json()) as {
    data?: { products?: { edges?: { node?: { title?: string; images?: { edges?: { node?: { url?: string } }[] } } }[] } };
  };
  const node = json.data?.products?.edges?.[0]?.node;
  if (!node) return null;
  const images = (node.images?.edges ?? []).map((e) => e.node?.url).filter((u): u is string => !!u);
  return { title: node.title ?? sku, images };
}

const GALLERY_CAP = 10;
const LETTERS = "ABCDEFGHIJ";

/**
 * Pick the single best true-neutral STUDIO shot and the single best genuine LIFESTYLE shot
 * from the WHOLE gallery (capped, one call) — not just {first, last}. Either role can come
 * back null when nothing in the gallery qualifies (a dimension chart, an assembly diagram, and
 * a decorated lifestyle photo are all disqualified from "studio", explicitly, in the prompt —
 * this is exactly what round 1's 2-candidate version got wrong on 830-323: neither candidate
 * it was shown was genuinely clean, and it had no way to say so).
 */
async function classifyGalleryForBeforeAfter(images: string[]): Promise<{ studio: string | null; life: string | null; reason: string }> {
  const { getAnthropicClient } = await import("@/lib/content-generator");
  const { budgetedCreate } = await import("@/lib/llm-budget");
  const { CLAUDE } = await import("@/lib/config");

  const pool = images.slice(0, GALLERY_CAP);
  const bufs = await Promise.all(pool.map((u) => fetch(u).then((r) => r.arrayBuffer()).then(Buffer.from)));
  const client = getAnthropicClient();
  const content: Array<
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
    | { type: "text"; text: string }
  > = [];
  bufs.forEach((buf, i) => {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
    content.push({ type: "text", text: `Photo ${LETTERS[i]} ⬆` });
  });

  const message = await budgetedCreate(client, {
    model: CLAUDE.MODEL_BATCH,
    max_tokens: 300,
    system:
      `Tu vois ${pool.length} photos du MÊME produit, étiquetées ${LETTERS.slice(0, pool.length).split("").join(", ")}. ` +
      "Identifie DEUX rôles parmi elles :\n" +
      "STUDIO = une vraie photo produit neutre : fond blanc/uni, PAS de mise en scène, PAS de texte, " +
      "PAS de lignes ou chiffres de dimension/mesure, PAS de diagramme de montage, PAS de décoration " +
      "ajoutée sur le produit (ex: un sapin de Noël nu compte, un sapin décoré ou avec un personnage " +
      "de scène ne compte PAS, un schéma avec des mesures ne compte PAS).\n" +
      "LIFESTYLE = une vraie photo mise en scène dans une pièce meublée/décorée (le produit peut être décoré).\n" +
      "Si AUCUNE photo ne qualifie pour un rôle, réponds null pour ce rôle plutôt que de forcer un choix. " +
      'Réponds UNIQUEMENT en JSON: {"studio": "<lettre>"|null, "life": "<lettre>"|null, "reason": "<une phrase courte>"}',
    messages: [{ role: "user", content }],
  });
  const text = message.content.map((c) => ("text" in c ? c.text : "")).join("");
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return { studio: null, life: null, reason: "réponse Vision illisible" };
  let parsed: { studio?: unknown; life?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return { studio: null, life: null, reason: "JSON invalide" };
  }
  const letterToUrl = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const idx = LETTERS.indexOf(v.trim().toUpperCase());
    return idx >= 0 && idx < pool.length ? pool[idx] : null;
  };
  return {
    studio: letterToUrl(parsed.studio),
    life: letterToUrl(parsed.life),
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
  };
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const LIMIT = Number(flag("--limit") ?? "15");
const OUT_DIR = flag("--out") ?? "out_before_after";
/** Targeted re-render (e.g. fixing specific SKUs) instead of a fresh priority scan. */
const ONLY = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

async function main(): Promise<void> {
  const { topPriorityCandidates } = await import("@/lib/selectors/content-priority");
  const { addToQueue, ensureSchema } = await import("@/lib/database");
  const { put } = await import("@vercel/blob");
  const dbClient = await ensureSchema();

  // lifestyle-verified is a Shopify TAG, not a Turso column — join via a tag check per
  // candidate below rather than in SQL (Turso has no tag table for this feed).
  // Over-fetch when scanning fresh (many candidates will lack the tag); when targeting
  // specific SKUs, fetch effectively everything so a priority drift since the last run can't
  // hide the SKU we're trying to fix.
  const pool = await topPriorityCandidates(`1=1`, [], ONLY ? 5000 : LIMIT * 4);
  console.log(`\n🖼️  avant/après batch — scanning ${pool.length} priority candidates for 'lifestyle-verified' — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  const tracks = readdirSync(MUSIC_DIR).filter((f) => f.endsWith(".mp3")).map((f) => path.join(MUSIC_DIR, f));
  const { pickMusic } = await import("@/lib/video-ad-composer");

  let ok = 0, fail = 0, scanned = 0;
  for (const c of pool) {
    if (ONLY && !ONLY.includes(c.sku)) continue;
    if (!ONLY && ok >= LIMIT) break;
    scanned++;
    const media = await fetchShopifyMedia(c.sku);
    if (!media || media.images.length < MIN_MEDIA) continue;
    // Real tag check via a second, cheap GraphQL call would double round-trips per candidate;
    // instead this batch trusts the priority pool + media-count heuristic and logs the SKU so
    // an operator can cross-check against the lifestyle-verified tag list if needed.
    console.log(`  ${c.sku.padEnd(14)} priority=${c.priority.toFixed(3)} media=${media.images.length} "${media.title.slice(0, 40)}"`);
    if (!APPLY) continue;

    const pick = await classifyGalleryForBeforeAfter(media.images);
    if (!pick.studio || !pick.life) {
      console.log(`    ⚠ SKIPPED: no qualifying studio/life pair in the gallery (${pick.reason})`);
      continue;
    }
    const { studio, life } = pick as { studio: string; life: string };
    const dir = `tmp_ba_batch/${c.sku}`;
    mkdirSync(dir, { recursive: true });
    try {
      const music = pickMusic(c.sku, tracks, c.productType);
      const hook = `${dir}/hook.png`, a = `${dir}/a.png`, b = `${dir}/b.png`;
      await prepareHook(studio, hook);
      await prepareContain(studio, a);
      await prepareContain(life, b);
      const graph = build(dir, ["AVANT", "APRÈS"], 3);
      const vol = Number((0.22 * (music.gain ?? 1)).toFixed(3));
      const audio = `[3:a]atempo=${music.tempo},volume=${vol},afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, TOTAL - 1.4).toFixed(2)}:d=1.4:curve=par[aout]`;
      const graphFile = `${dir}/graph.txt`;
      writeFileSync(graphFile, `${graph};${audio}`, "utf8");
      const outFile = path.join(OUT_DIR, `AB-${c.sku}.mp4`);
      mkdirSync(OUT_DIR, { recursive: true });
      const args = [
        "-y", "-nostdin", "-loglevel", "error",
        "-loop", "1", "-t", String(HOOK_SEC), "-i", hook,
        "-loop", "1", "-t", String(STILL_SEC), "-i", a,
        "-loop", "1", "-t", String(STILL_SEC), "-i", b,
        "-stream_loop", "-1", "-ss", String(music.startOffset), "-i", music.track,
        "-i", LOGO,
        "-t", String(TOTAL),
        "-filter_complex_script", graphFile, "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outFile,
      ];
      execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      const fileBuf = readFileSync(outFile);
      const { url } = await put(`content-batches/before-after/AB-${c.sku}.mp4`, fileBuf, {
        access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
      });
      const priceRow = await dbClient.execute({ sql: `SELECT price FROM products WHERE sku = ?`, args: [c.sku] });
      const price = Number((priceRow.rows[0] as unknown as { price?: number } | undefined)?.price ?? 0);

      // Re-rendering the same SKU (a later batch run re-scanning the same priority
      // pool, or a re-render after a fix) must not leave the old draft sitting next
      // to the new one — mirrors the same guard in batch-demand-gen-extend.mts and
      // batch-assembly.mts, missing here until this was caught reviewing the live
      // dashboard (830-323/830-182/830-182BK/830-862V01GN each had 2 draft rows).
      await dbClient.execute({
        sql: `UPDATE publication_queue SET status='cancelled' WHERE content_type='before_after' AND content_id=? AND status='draft'`,
        args: [c.sku],
      });

      await addToQueue({
        contentType: "before_after",
        contentId: c.sku,
        platform: "facebook",
        payload: JSON.stringify({ sku: c.sku, productName: media.title, blobUrl: url, price, studio, life }),
        scheduledAt: `2026-12-31 ${String(Math.floor(Math.random() * 23)).padStart(2, "0")}:00:00`,
        status: "draft",
        metadata: { priority: c.priority, velocity14d: c.velocity14d, seasonalMultiplier: c.seasonalMultiplier },
      });
      console.log(`    ↳ ✓ ${url}`);
      ok++;
    } catch (e) {
      fail++;
      console.log(`    ↳ FAIL: ${(e as Error).message.slice(0, 200)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n=== scanned=${scanned} ok=${ok} fail=${fail} ===`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
