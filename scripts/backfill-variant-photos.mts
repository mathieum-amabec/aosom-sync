/**
 * backfill-variant-photos — make clicking a colour show that colour's photo, on existing
 * multi-colour products (audit 2026-09-30: 498 of 554 had at least one colour that didn't
 * switch the photo; ~716 colours had no photo of their own in the gallery, because the import
 * capped the gallery at 8 photos across ALL colours).
 *
 * Per product with 2+ colours, per colour (all variants of that colour share the photo):
 *   1. its own photo = the first Aosom CSV image of its SKUs that is already in the gallery —
 *      matched by file stem, else by perceptual hash (dHash 16×16, ≤ 24/256 bits + same centre colour; Aosom
 *      renames files, so names alone miss real matches);
 *   2. if none is in the gallery, the colour's primary CSV image is ADDED to the gallery;
 *   3. a colour with no CSV image at all (SKU gone from the feed) gets the position-1 photo,
 *      so no variant is ever left without one (the theme would keep the previous colour's).
 * Products where every variant already has the right photo are skipped.
 *
 * USAGE (x64 Node, prod creds):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-variant-photos.mts            # dry-run
 *   …scripts/backfill-variant-photos.mts --apply [--limit=10] [--ids=123,456] [--checkpoint=path]
 * Writes a JSONL backup of every variant's previous image_id before touching it (--backup).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import sharp from "sharp";

const STORE = "27u5y2-kp.myshopify.com", API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const FEED = process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv";
const APPLY = process.argv.includes("--apply");
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONLY = arg("ids") ? new Set(arg("ids")!.split(",")) : null;
const CHECKPOINT = arg("checkpoint") ?? ".tmp-variant-photos-done.jsonl";
const BACKUP = arg("backup") ?? ".tmp-variant-photos-backup.jsonl";
const REVIEW = arg("review") ?? ".tmp-variant-photos-a-revoir.jsonl";
const HASH_MAX_DISTANCE = 24; // correct look-alike matches in the audit were 9–18; 26–30 included wrong colours

let last = 0;
async function throttle() {
  const wait = 520 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  for (let a = 0; a < 6; a++) {
    await throttle();
    const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await res.json();
    if (res.status === 429 || j.errors?.some((e: { message: string }) => /throttl/i.test(e.message))) {
      await new Promise((r) => setTimeout(r, 3000 * (a + 1)));
      continue;
    }
    if (!j.data) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  }
  throw new Error("throttled");
}
async function rest(path: string, method: string, body: unknown) {
  for (let a = 0; a < 5; a++) {
    await throttle();
    const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, {
      method,
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); continue; }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`${method} ${path}: throttled`);
}

const stem = (u: string) => u.split("/").pop()!.split("?")[0].replace(/\.[a-z]+$/i, "").replace(/_[0-9a-f-]{36}$/i, "");

function parseCsv(t: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  return rows;
}

const hashCache = new Map<string, Uint8Array | null>();
async function dhash(url: string): Promise<Uint8Array | null> {
  if (hashCache.has(url)) return hashCache.get(url)!;
  let h: Uint8Array | null = null;
  try {
    const res = await fetch(url.includes("cdn.shopify.com") ? `${url}${url.includes("?") ? "&" : "?"}width=256` : url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.ok) {
      const px = await sharp(Buffer.from(await res.arrayBuffer())).grayscale().resize(17, 16, { fit: "fill" }).raw().toBuffer();
      const bits = new Uint8Array(256);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits[y * 16 + x] = px[y * 17 + x] > px[y * 17 + x + 1] ? 1 : 0;
      h = bits;
    }
  } catch { h = null; }
  hashCache.set(url, h);
  return h;
}
/** Mean RGB of the central 50 % of the photo — dHash is grayscale and colour-blind (a black
 *  and a cream stool of the same shape hash alike), so a visual match must also agree on colour. */
const colourCache = new Map<string, [number, number, number] | null>();
async function centreColour(url: string): Promise<[number, number, number] | null> {
  if (colourCache.has(url)) return colourCache.get(url)!;
  let c: [number, number, number] | null = null;
  try {
    const res = await fetch(url.includes("cdn.shopify.com") ? `${url}${url.includes("?") ? "&" : "?"}width=256` : url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.ok) {
      const px = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().resize(32, 32, { fit: "fill" }).raw().toBuffer();
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) { const i = (y * 32 + x) * 3; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
      c = [r / n, g / n, b / n];
    }
  } catch { c = null; }
  colourCache.set(url, c);
  return c;
}
const colourGap = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const COLOUR_MAX_GAP = 40;

const distance = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

interface Variant { id: string; sku: string; image: { id: string } | null; selectedOptions: { name: string; value: string }[] }
interface Img { id: string; url: string }
interface Prod { id: string; title: string; handle: string; variants: { nodes: Variant[] }; images: { nodes: Img[] } }

async function main() {
  const csv = parseCsv(await (await fetch(FEED)).text());
  const h = csv[0], ix = (k: string) => h.indexOf(k);
  const imgCols = ["Image", "Image1", "Image2", "Image3", "Image4", "Image5", "Image6", "Image7"].map(ix);
  const feedImages = new Map<string, string[]>();
  for (const r of csv.slice(1)) if (r[0]) feedImages.set(r[0].trim(), imgCols.map((i) => (r[i] || "").trim()).filter(Boolean));

  const done = new Set<string>(existsSync(CHECKPOINT) ? readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const prods: Prod[] = [];
  let cursor: string | null = null;
  do {
    const d: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Prod[] } } = await gql(
      `query($c:String){products(first:40,after:$c,query:"status:active"){pageInfo{hasNextPage endCursor} nodes{id title handle
        variants(first:100){nodes{id sku image{id} selectedOptions{name value}}} images(first:100){nodes{id url}}}}}`,
      { c: cursor },
    );
    prods.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  const candidates = prods.filter((p) => {
    if (ONLY && !ONLY.has(p.id.split("/").pop()!)) return false;
    if (done.has(p.id)) return false;
    return new Set(p.variants.nodes.map((v) => v.selectedOptions.find((o) => o.name === "Couleur")?.value).filter(Boolean)).size >= 2;
  });
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — produits multi-couleurs à examiner: ${candidates.length}`);

  const stats = { products: 0, unchanged: 0, byStem: 0, byHash: 0, uploaded: 0, fallbackPos1: 0, variants: 0, failed: 0 };
  for (const p of candidates.slice(0, LIMIT)) {
    try {
      const gallery = p.images.nodes;
      if (gallery.length === 0) continue;
      const byStem = new Map(gallery.map((g) => [stem(g.url), g.id]));
      const colours = new Map<string, Variant[]>();
      for (const v of p.variants.nodes) {
        const c = v.selectedOptions.find((o) => o.name === "Couleur")?.value ?? "";
        colours.set(c, [...(colours.get(c) ?? []), v]);
      }
      const target = new Map<string, string>(); // variant id → image id
      const notes: string[] = [];
      const used = new Set<string>(); // one photo per colour — never the same photo for two colours
      // Only each SKU's PRIMARY feed photo (the CSV "Image" column) represents its colour —
      // secondary shots (accessories, close-ups, infographics) never do. Real finding on the
      // first full pass: a blue pool table got its "accessories" shot because that was the
      // first of its photos already in the gallery.
      const ownByColour = new Map([...colours].map(([c, vs]) => [c, [...new Set(vs.map((v) => (feedImages.get(v.sku) ?? [])[0]).filter(Boolean))]]));
      // Phase 1 — exact file matches for EVERY colour first. Any gallery photo whose file stem is
      // some colour's own primary is reserved for that colour: a look-alike match for another
      // colour can't take it, nor a duplicate copy of it (same stem, other id). Real finding on
      // the second pass: "Brun rustique" took the black bookcase photo by resemblance because it
      // was processed first; a black mirror took the gold one (thin frame, white centre).
      const claimedStems = new Set([...ownByColour.values()].flat().map(stem));
      const exact = new Map<string, string>();
      for (const [colour, own] of ownByColour) {
        const id = own.map((u) => byStem.get(stem(u))).find((x) => x && !used.has(x));
        if (id) { exact.set(colour, id); used.add(id); }
      }
      for (const [colour, vs] of colours) {
        const own = ownByColour.get(colour) ?? [];
        let imageId: string | undefined = exact.get(colour);
        let how = "nom";
        if (!imageId && own.length) {
          const want = await dhash(own[0]);
          if (want !== null) {
            let best: { id: string; d: number } | null = null;
            const wantColour = await centreColour(own[0]);
            for (const g of gallery) {
              if (used.has(g.id) || claimedStems.has(stem(g.url))) continue;
              const gc = await centreColour(g.url);
              if (!wantColour || !gc || colourGap(wantColour, gc) > COLOUR_MAX_GAP) continue;
              const gh = await dhash(g.url);
              if (gh === null) continue;
              const d = distance(want, gh);
              if (!best || d < best.d) best = { id: g.id, d };
            }
            if (best && best.d <= HASH_MAX_DISTANCE) { imageId = best.id; how = `visuel(${best.d})`; }
          }
        }
        if (!imageId && own.length) {
          how = "ajoutée";
          if (APPLY) {
            const path = `/products/${p.id.split("/").pop()}/images.json`;
            let created;
            try {
              created = await rest(path, "POST", { image: { src: own[0] } });
            } catch (err) {
              // Shopify sometimes times out fetching from Aosom's CDN — fetch it ourselves and
              // send the bytes instead (same photo, just a different transport).
              if (!/Could not download image/.test(String(err))) throw err;
              const res = await fetch(own[0], { headers: { "User-Agent": "Mozilla/5.0" } });
              if (!res.ok) throw err;
              const attachment = Buffer.from(await res.arrayBuffer()).toString("base64");
              created = await rest(path, "POST", { image: { attachment, filename: own[0].split("/").pop() } });
            }
            imageId = `gid://shopify/ProductImage/${created.image.id}`;
          } else imageId = "NOUVELLE";
        }
        if (!imageId) { imageId = gallery[0].id; how = "pos-1 (aucune photo Aosom)"; stats.fallbackPos1++; }
        else if (how === "nom") stats.byStem++;
        else if (how.startsWith("visuel")) stats.byHash++;
        else if (how === "ajoutée") stats.uploaded++;
        if (imageId !== gallery[0].id || how !== "pos-1 (aucune photo Aosom)") used.add(imageId);
        for (const v of vs) target.set(v.id, imageId);
        notes.push(`${colour}:${how}`);
      }
      // Colours with no feed photo at all fall back to the pos-1 photo (another colour):
      // list them for a human look — the colour may be discontinued.
      if (APPLY) for (const n of notes) if (n.includes("pos-1")) {
        appendFileSync(REVIEW, JSON.stringify({ handle: p.handle, title: p.title, colour: n.split(":")[0] }) + "\n");
      }
      const changes = p.variants.nodes.filter((v) => target.get(v.id) !== v.image?.id);
      if (changes.length === 0) {
        stats.unchanged++;
        if (APPLY) appendFileSync(CHECKPOINT, JSON.stringify({ id: p.id, variants: 0 }) + "\n");
        continue;
      }
      stats.products++;
      if (stats.products <= 12) console.log(`  ${p.handle.slice(0, 60)} — ${changes.length} variante(s) — ${notes.join(", ")}`);
      if (!APPLY) continue;
      for (const v of changes) {
        appendFileSync(BACKUP, JSON.stringify({ product: p.id, variant: v.id, sku: v.sku, previousImage: v.image?.id ?? null }) + "\n");
        const vid = v.id.split("/").pop();
        await rest(`/variants/${vid}.json`, "PUT", { variant: { id: Number(vid), image_id: Number(target.get(v.id)!.split("/").pop()) } });
        stats.variants++;
      }
      appendFileSync(CHECKPOINT, JSON.stringify({ id: p.id, variants: changes.length }) + "\n");
    } catch (err) {
      stats.failed++;
      console.error(`  ÉCHEC ${p.handle}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nRÉSUMÉ — produits à corriger: ${stats.products} | déjà bons: ${stats.unchanged} | couleurs trouvées par nom: ${stats.byStem}, par comparaison visuelle: ${stats.byHash}, photos ajoutées: ${stats.uploaded}, sans photo Aosom (pos-1): ${stats.fallbackPos1} | variantes modifiées: ${stats.variants} | échecs: ${stats.failed}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
