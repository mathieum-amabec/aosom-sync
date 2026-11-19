#!/usr/bin/env tsx
/**
 * curate-top-photos — « Corrige les 200 produits les plus populaires : change leur photo ».
 *
 * For the most popular LIVE products (input `.tmp-top200/top200-live.json`, ranked by supplier demand):
 *   1. pos-1 (main photo) becomes a CLEAN LIFESTYLE photo (no marketing text / dimension callouts), taken from the Shopify
 *      gallery first (a reorder), else from the Aosom feed (an upload). An already clean lifestyle pos-1 is left alone.
 *   2. on MULTI-COLOUR products, each colour's variant image becomes a clean lifestyle photo OF THAT COLOUR instead of the
 *      white-background packshot. Only photos EXCLUSIVE to the colour are eligible (`exclusiveImages`), and never the same
 *      photo for two colours — that is exactly what the daily `variant-photo-guard` (cron 11:30 UTC) accepts, so it will
 *      not revert the result. A colour with no exclusive clean lifestyle photo KEEPS its current image (never degrade) and
 *      is reported as `no-lifestyle-exclusive`.
 *
 * Verdicts: "lifestyle" = `classifyAdImageStyle` (0 token, cache `image_styles`); "no overlay text" = Vision
 * (`classifyProductImage`, cache `image_classifications`) + a strong-tier second opinion on every photo about to be
 * published (the lite tier once said "clean" on an infographic). A classification failure is NEVER "clean": unknown ⇒ unused.
 *
 * DRY-RUN BY DEFAULT: nothing is written to Shopify or to Turso (except the two classification caches above).
 * `--apply` writes. Every product gets a JSONL backup BEFORE the first write (`--rollback` restores it), mirrored outside the worktree.
 *
 * USAGE (x64 Node, prod creds in .env.local — never print them):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/curate-top-photos.mts [options]
 *     --limit N            process N ACTIVE products (default: all)
 *     --start I            start at index I of the input list (default 0)
 *     --ids a,b            only these Shopify product ids
 *     --max-seconds S      stop starting new products after S seconds (default 540) and print the next --start
 *     --apply              write to Shopify (+ image_checked_at, close open image_review_queue rows)
 *     --skip-done          skip products already in the checkpoint (always on with --apply)
 *     --report NAME        report base name in .tmp-top200/photos/ (default "report")
 *     --rollback <id|all>  restore from backup.jsonl (dry-run unless --apply): old variant images, old pos-1,
 *                          deletes ONLY images this script uploaded. Never deletes an original image.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ─── CLI ────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const APPLY = flag("apply");
const ROLLBACK_FLAG = flag("rollback");
const ROLLBACK = opt("rollback");
// `--rollback` WITHOUT a value (or with something that is neither a product id nor `all`) must abort and do NOTHING else:
// it must never fall through to a normal planning/apply run.
if (ROLLBACK_FLAG && !(ROLLBACK && (ROLLBACK === "all" || /^\d+$/.test(ROLLBACK)))) {
  console.error("--rollback exige une valeur : un id produit Shopify (numérique) ou `all`. Rien n'a été fait.");
  process.exit(1);
}
const LIMIT = opt("limit") ? Number(opt("limit")) : Infinity;
const START = opt("start") ? Number(opt("start")) : 0;
const ONLY = opt("ids") ? new Set(opt("ids")!.split(",").map((s) => s.trim())) : null;
const MAX_SECONDS = opt("max-seconds") ? Number(opt("max-seconds")) : 540;
const SKIP_DONE = flag("skip-done") || APPLY;
const REPORT_NAME = opt("report") ?? "report";

const DIR = ".tmp-top200/photos";
const INPUT = ".tmp-top200/top200-live.json";
const BACKUP = `${DIR}/backup.jsonl`;
const CHECKPOINT = `${DIR}/checkpoint.jsonl`;
const STRONG_CACHE = `${DIR}/strong-confirm.jsonl`;
const FULLVIEW_CACHE = `${DIR}/fullview-cache.jsonl`;
/** Durable copy of every backup line, OUTSIDE the worktree (a worktree can be removed; the originals must survive). */
const DURABLE_BACKUP = "C:\\Users\\vente\\Documents\\aosom-photo-backups\\backup.jsonl";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const COLOUR_OPT = /^(couleur|color|colour|coloris)$/i;
const GALLERY_CAP = 250;
/**
 * Candidate budgets per product part: cheap style downloads (0 token) vs Vision candidates (cached verdicts are free).
 * The old fixed cap of 5 exhausted the vision budget before reaching the clean scene photo (often feed image #7).
 * Candidates are walked in order: only photos whose style is "lifestyle" are eligible, in feed/gallery order, so the
 * likely scenes are the ones that consume the vision budget.
 */
const MAX_STYLE_CHECKS_COLOUR = 14;
const MAX_STYLE_CHECKS_POS1 = 40;
const MAX_VISION_CANDIDATES_COLOUR = 12;
const MAX_VISION_CANDIDATES_POS1 = 12;
const REST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 45_000;

function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const appendJsonl = (file: string, o: unknown) => { ensureDir(file); appendFileSync(file, `${JSON.stringify(o)}\n`, "utf8"); };
function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* truncated line */ }
  }
  return out;
}

// ─── Shopify REST (≤ 2 req/s) ───────────────────────────────────────────────────

let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = 520 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}
const counters = {
  styleDownloads: 0, styleCacheHits: 0, styleUnknown: 0,
  liteCalls: 0, liteCacheHits: 0, strongCalls: 0, strongCacheHits: 0, visionErrors: 0,
  fullLiteCalls: 0, fullLiteCacheHits: 0, fullStrongCalls: 0, fullStrongCacheHits: 0, fullErrors: 0,
  fullRefusedLite: 0, fullRefusedStrong: 0,
  shopifyReads: 0, shopifyWrites: 0,
};
/** Paid vision calls so far (overlay verdicts + whole-product checks), per tier. */
const liteTotal = () => counters.liteCalls + counters.fullLiteCalls;
const strongTotal = () => counters.strongCalls + counters.fullStrongCalls;

/** A POST that may or may not have been applied (5xx / timeout / network): NEVER blindly retried. */
class AmbiguousWriteError extends Error {}

async function rest<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    if (method === "GET") counters.shopifyReads++; else counters.shopifyWrites++;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`https://${STORE}/admin/api/${API}${path}`, {
        method,
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (method === "POST") throw new AmbiguousWriteError(`${method} ${path}: réseau/timeout (${msg.slice(0, 120)})`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; } // rejected before processing: always safe to retry
    if (res.status >= 500) {
      // A POST (image upload) that 5xx'd may have been applied: retrying could duplicate it. Caller reconciles.
      if (method === "POST") throw new AmbiguousWriteError(`${method} ${path}: ${res.status}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new Error(`${method} ${path}: throttled / 5xx after 6 attempts`);
}

interface ShopVariant { id: number; sku: string; option1?: string | null; option2?: string | null; option3?: string | null; image_id: number | null }
interface ShopImage { id: number; position: number; src: string; variant_ids?: number[] }
interface ShopProduct {
  id: number; handle: string; title: string; status: string; tags: string;
  options: Array<{ name: string; position: number; values: string[] }>;
  variants: ShopVariant[]; images: ShopImage[];
}

async function readProduct(pid: string | number): Promise<ShopProduct | null> {
  try {
    const r = await rest<{ product?: ShopProduct }>(`/products/${pid}.json?fields=id,handle,title,status,tags,options,variants,images`);
    if (!r.product) return null;
    r.product.images = [...(r.product.images ?? [])].sort((a, b) => a.position - b.position);
    return r.product;
  } catch (err) {
    if (/: 404 /.test(String(err))) return null;
    throw err;
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Uploads the feed photo as a base64 attachment (Shopify's own fetch of the Aosom CDN is refused ~40 % of the time).
 * Precondition: the photo's imageKey is NOT in the gallery yet. So when the POST answers 5xx / times out, a re-read of the
 * gallery that finds the key means the upload DID land: it is reused (never re-POSTed → no duplicate). `recovered` tells the
 * caller the `variant_ids` attachment cannot be assumed.
 */
async function uploadAttachment(pid: number, url: string, variantIds?: number[]): Promise<{ image: ShopImage; recovered: boolean }> {
  const buf = await download(url);
  const filename = url.split("?")[0].split("/").pop() ?? "photo.jpg";
  const image: Record<string, unknown> = { attachment: buf.toString("base64"), filename };
  if (variantIds?.length) image.variant_ids = variantIds;
  try {
    const r = await rest<{ image?: ShopImage }>(`/products/${pid}/images.json`, "POST", { image });
    if (!r.image?.id) throw new Error(`upload to ${pid}: no image id returned`);
    return { image: r.image, recovered: false };
  } catch (err) {
    if (!(err instanceof AmbiguousWriteError)) throw err;
    const key = L.photos.imageKey(url);
    const cur = await readProduct(pid); // a throw here propagates: the outcome stays unknown, the product is marked failed
    const hit = key ? cur?.images.find((g) => L.photos.imageKey(g.src) === key) : undefined;
    if (!hit) throw err;
    return { image: hit, recovered: true };
  }
}

// ─── Library (tsx exposes named exports on `default` for the CJS src/) ─────────

const unwrap = <T,>(m: T): T => ((m as { default?: T }).default ?? m);

async function loadLib() {
  const [audit, db, style, vision, photos, csv, colours, models, generator, budget, guard] = await Promise.all([
    import("@/lib/image-compliance-audit"),
    import("@/lib/database"),
    import("@/lib/image-style"),
    import("@/lib/vision-classifier"),
    import("@/lib/variant-photos"),
    import("@/lib/csv-fetcher"),
    import("@/lib/colour-names"),
    import("@/lib/llm-models"),
    import("@/lib/content-generator"),
    import("@/lib/llm-budget"),
    import("@/lib/variant-photo-guard"),
  ]);
  return {
    audit: unwrap(audit), db: unwrap(db), style: unwrap(style), vision: unwrap(vision),
    photos: unwrap(photos), csv: unwrap(csv), colours: unwrap(colours), models: unwrap(models),
    generator: unwrap(generator), budget: unwrap(budget), guard: unwrap(guard),
  };
}
type Lib = Awaited<ReturnType<typeof loadLib>>;
let L: Lib;

// ─── Classifiers (cached) ───────────────────────────────────────────────────────

type Style = "lifestyle" | "studio";
interface Verdict { compliant: boolean; reason: string; confidence?: number }
const styleMemo = new Map<string, Style | null>();
const verdictMemo = new Map<string, Verdict | null>();
const strongMemo = new Map<string, Verdict | null>();

const isClean = (v: Verdict) => v.compliant && (v.confidence === undefined || v.confidence >= L.audit.MIN_AUTO_CONFIDENCE);
const stemOf = (url: string) => L.audit.imageUrlStem(url);

/** lifestyle | studio | null (cannot be decided — NEVER treated as lifestyle). Cache `image_styles`. */
async function styleOf(url: string): Promise<Style | null> {
  const stem = stemOf(url);
  if (!stem) return null;
  if (styleMemo.has(stem)) return styleMemo.get(stem)!;
  const cached = (await L.db.getCachedImageStyles([stem])).get(stem);
  if (cached) { counters.styleCacheHits++; styleMemo.set(stem, cached); return cached; }
  counters.styleDownloads++;
  const s = await L.style.classifyAdImageStyle(url);
  if (s) await L.db.putCachedImageStyles([{ stem, style: s, sampleUrl: url }]);
  else counters.styleUnknown++;
  styleMemo.set(stem, s);
  return s;
}

/** Lite Vision verdict (overlay text?) — cached by photo stem in `image_classifications`; null = could not be judged. */
async function verdictOf(url: string): Promise<Verdict | null> {
  const stem = stemOf(url);
  if (!stem) return null;
  if (verdictMemo.has(stem)) return verdictMemo.get(stem)!;
  const cached = (await L.db.getCachedImageVerdicts([stem])).get(stem);
  if (cached) { counters.liteCacheHits++; verdictMemo.set(stem, cached); return cached; }
  let v: Verdict | null = null;
  try {
    counters.liteCalls++;
    const r = await L.vision.classifyProductImage(url, { maintenance: true, px: 512 });
    v = { compliant: r.compliant, reason: r.reason, confidence: r.confidence };
    await L.db.putCachedImageVerdict(stem, v, { model: `${L.models.llmModel("lite")}@512`, sampleUrl: url });
  } catch (err) {
    counters.visionErrors++;
    console.log(`    vision error (${stem}): ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
  verdictMemo.set(stem, v);
  return v;
}

/** Strong-tier second opinion on a photo about to be published; file-cached so a re-run does not pay twice. */
async function strongOf(url: string): Promise<Verdict | null> {
  const stem = stemOf(url);
  if (!stem) return null;
  if (strongMemo.size === 0) {
    for (const r of readJsonl<{ stem: string } & Verdict>(STRONG_CACHE)) strongMemo.set(r.stem, { compliant: r.compliant, reason: r.reason, confidence: r.confidence });
  }
  if (strongMemo.has(stem)) { counters.strongCacheHits++; return strongMemo.get(stem)!; }
  let v: Verdict | null = null;
  try {
    counters.strongCalls++;
    const r = await L.vision.classifyProductImage(url, { maintenance: true, tier: "strong" });
    v = { compliant: r.compliant, reason: r.reason, confidence: r.confidence };
    await L.db.putCachedImageVerdict(stem, v, { model: `${L.models.llmModel("strong")}@${L.vision.DEFAULT_CLASSIFY_PX}`, sampleUrl: url });
    appendJsonl(STRONG_CACHE, { stem, ...v });
  } catch (err) {
    counters.visionErrors++;
    console.log(`    strong vision error (${stem}): ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
  strongMemo.set(stem, v);
  return v;
}

// ── "Whole product visible" check ─────────────────────────────────────────────────
// The overlay classifier is BINARY (marketing text or not) and cannot tell a scene from a macro: a visual QA of 42 planned
// changes found clean close-ups (hands on fabric, two drawer handles, a leather macro with a brand tag) picked as the main
// photo. So EVERY photo about to be used (upload, attach, pos-1 move) must also show the whole product in a scene.

const FULLVIEW_PROMPT = `Tu es un contrôleur de photos e-commerce. Ta SEULE tâche : dire si la photo montre le PRODUIT ENTIER (ou l'ensemble principal tel qu'il est vendu) clairement visible dans une mise en scène réelle (pièce, intérieur, terrasse, jardin, décor).

Réponds UNIQUEMENT en JSON, ce format exact :
{"fullProduct": <true|false>, "reason": "<une phrase courte>"}

fullProduct = true SEULEMENT si le produit complet est clairement visible et reconnaissable, dans un décor/une scène.

fullProduct = false pour :
- un gros plan, une macro ou une vue de détail (texture, tissu, cuir, couture, poignée, charnière, roulette, pied, mécanisme)
- des mains ou une personne qui tient/touche une partie du produit, sans que le produit entier soit visible
- une étiquette, un logo, une marque, un tag en gros plan
- un seul accessoire ou composant isolé (un coussin, une poignée, une pièce) à la place du produit principal
- un collage, une mosaïque ou plusieurs photos juxtaposées
- un produit à peine reconnaissable, minuscule dans le cadre, fortement coupé, caché ou masqué par d'autres objets
- une pièce dont le produit n'est pas le sujet

Au moindre doute, réponds false.`;

interface FullView { fullProduct: boolean; reason: string }
const fullMemo = new Map<string, FullView | null>(); // key `${tier}:${stem}`

function loadFullCache(): void {
  if (fullMemo.size > 0) return;
  for (const r of readJsonl<{ stem: string; tier: string; fullProduct: boolean; reason: string }>(FULLVIEW_CACHE)) {
    fullMemo.set(`${r.tier}:${r.stem}`, { fullProduct: r.fullProduct, reason: r.reason });
  }
}

/** 512px request for a Shopify CDN URL (Shopify-only `_WxH` suffix, same rule as vision-classifier.ts); other URLs unchanged. */
function sizedForVision(src: string, px: number): string {
  if (!/(^|\.)shopify(cdn)?\.com\//.test(src) && !src.includes("/s/files/")) return src;
  const [path, query] = src.split("?");
  if (!/\.[a-zA-Z]+$/.test(path)) return src;
  const resized = path.replace(/(\.[a-zA-Z]+)$/, `_${px}x${px}$1`);
  return query ? `${resized}?${query}` : resized;
}
function mediaTypeOf(src: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const path = src.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/** Whole-product verdict by tier, cached by photo stem (file + memory). null = could not be judged ⇒ NEVER usable. */
async function fullViewOf(url: string, tier: "lite" | "strong"): Promise<FullView | null> {
  const stem = stemOf(url);
  if (!stem) return null;
  loadFullCache();
  const key = `${tier}:${stem}`;
  if (fullMemo.has(key)) {
    if (fullMemo.get(key)) { if (tier === "lite") counters.fullLiteCacheHits++; else counters.fullStrongCacheHits++; }
    return fullMemo.get(key)!;
  }
  let v: FullView | null = null;
  try {
    if (tier === "lite") counters.fullLiteCalls++; else counters.fullStrongCalls++;
    const b64 = (await download(sizedForVision(url, 512))).toString("base64");
    const message = await L.budget.budgetedCreate(L.generator.getAnthropicClient(), {
      model: L.models.llmModel(tier),
      max_tokens: 300,
      system: FULLVIEW_PROMPT,
      messages: [{
        role: "user" as const,
        content: [
          { type: "image" as const, source: { type: "base64" as const, media_type: mediaTypeOf(url), data: b64 } },
          { type: "text" as const, text: "Le produit entier est-il visible dans une scène ?" },
        ],
      }],
    }, undefined, "maintenance");
    const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`pas de JSON: ${text.slice(0, 80)}`);
    const parsed = JSON.parse(m[0]) as { fullProduct?: unknown; reason?: unknown };
    if (typeof parsed.fullProduct !== "boolean") throw new Error("fullProduct manquant");
    v = { fullProduct: parsed.fullProduct, reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 160) : "" };
    appendJsonl(FULLVIEW_CACHE, { stem, tier, ...v });
  } catch (err) {
    counters.fullErrors++;
    console.log(`    fullview error (${tier}, ${stem}): ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
  fullMemo.set(key, v);
  return v;
}

/**
 * The first of `urls` (in order) that is a CLEAN, WHOLE-PRODUCT LIFESTYLE photo. Checks, cheapest first:
 * style (0 token; only "lifestyle" proceeds, so likely scenes use the vision budget) → overlay (lite) → whole product (lite)
 * → overlay (strong) → whole product (strong, ONLY for a feed photo that would be UPLOADED). Unknown ⇒ skipped.
 */
async function firstCleanLifestyle(
  urls: string[], maxStyle: number, maxVision: number, skipKeys: Set<string>, isFeedUpload: (url: string) => boolean,
): Promise<{ url: string; note: string } | { url: null; note: string; tried: number }> {
  let styled = 0, visioned = 0;
  const notes: string[] = [];
  const seenKeys = new Set<string>();
  for (const url of urls) {
    const key = L.photos.imageKey(url);
    if (!key || skipKeys.has(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (styled >= maxStyle) { notes.push("budget-style"); break; }
    styled++;
    const s = await styleOf(url);
    if (s !== "lifestyle") { notes.push(s === "studio" ? "studio" : "style?"); continue; }
    if (visioned >= maxVision) { notes.push("budget-vision"); break; }
    visioned++;
    const v = await verdictOf(url);
    if (!v) { notes.push("vision?"); continue; }
    if (!isClean(v)) { notes.push(`overlay (${v.reason.slice(0, 40)})`); continue; }
    const full = await fullViewOf(url, "lite");
    if (!full) { notes.push("fullview?"); continue; }
    if (!full.fullProduct) { counters.fullRefusedLite++; notes.push(`détail/produit non entier (${full.reason.slice(0, 40)})`); continue; }
    const strong = await strongOf(url);
    if (!strong) { notes.push("strong?"); continue; }
    if (!isClean(strong)) { notes.push(`overlay-strong (${strong.reason.slice(0, 40)})`); continue; }
    if (isFeedUpload(url)) {
      const fullStrong = await fullViewOf(url, "strong");
      if (!fullStrong) { notes.push("fullview-strong?"); continue; }
      if (!fullStrong.fullProduct) { counters.fullRefusedStrong++; notes.push(`détail/produit non entier-strong (${fullStrong.reason.slice(0, 40)})`); continue; }
    }
    return { url, note: `lifestyle propre, produit entier (${v.reason.slice(0, 60)})` };
  }
  return { url: null, note: notes.slice(0, 14).join(", ") || "aucune candidate", tried: styled };
}

// ─── Plan ───────────────────────────────────────────────────────────────────────

interface Thumb { src: string; style: Style | null; note?: string }
interface Pos1Plan {
  action: "keep" | "move" | "upload" | "none";
  /** keep: already-clean-lifestyle | style-unknown | vision-unknown ; none: no-clean-lifestyle */
  status: string;
  reason: string;
  before: Thumb | null;
  after?: { src: string; key: string; source: "gallery" | "feed"; imageId?: number };
}
interface ColourPlan {
  colour: string;
  skus: string[];
  variantIds: number[];
  /** change | keep */
  action: "keep" | "change";
  /** changed | already-lifestyle | per-size-photos | no-lifestyle-exclusive | label-contradiction | style-unknown | vision-unknown | image-cap */
  status: string;
  mode?: "attach" | "upload";
  reason: string;
  before: Thumb | null;
  after?: { src: string; key: string; imageId?: number };
}
interface ProductPlan {
  productId: string;
  handle: string;
  name: string;
  shopifyStatus: string;
  skipped?: string;
  nColours: number;
  pos1?: Pos1Plan;
  colours: ColourPlan[];
  openReviewRows: number;
  visionBefore: { lite: number; strong: number };
  visionAfter: { lite: number; strong: number };
}

async function planProduct(
  p: ShopProduct,
  feedBySku: ReadonlyMap<string, { color: string; psin: string; images: string[] }>,
  psinIndex: ReadonlyMap<string, Array<{ sku: string; color: string; images: string[] }>>,
): Promise<ProductPlan> {
  const plan: ProductPlan = {
    productId: String(p.id), handle: p.handle, name: p.title, shopifyStatus: p.status, nColours: 0, colours: [], openReviewRows: 0,
    visionBefore: { lite: liteTotal(), strong: strongTotal() }, visionAfter: { lite: 0, strong: 0 },
  };
  const gallery = p.images;
  if (gallery.length === 0) { plan.skipped = "galerie vide"; return plan; }
  const galleryById = new Map(gallery.map((g) => [g.id, g]));
  const galleryByKey = new Map<string, ShopImage>();
  for (const g of gallery) { const k = L.photos.imageKey(g.src); if (k && !galleryByKey.has(k)) galleryByKey.set(k, g); }

  // ── colours ──
  const used = new Set<string>(); // image keys chosen for a colour (never the same photo for 2 colours)
  const chosen = new Map<string, ColourPlan>(); // key → colour plan using it
  const colOpt = p.options.find((o) => COLOUR_OPT.test(o.name.trim()));
  if (colOpt && colOpt.values.length >= 2) {
    const key = `option${colOpt.position}` as "option1" | "option2" | "option3";
    const byColour = new Map<string, ShopVariant[]>();
    for (const v of p.variants) {
      const c = String(v[key] ?? "");
      if (!byColour.has(c)) byColour.set(c, []);
      byColour.get(c)!.push(v);
    }
    plan.nColours = byColour.size;
    // Same sources as the daily guard (planProduct in variant-photo-guard.ts), incl. the PSIN twin of a renamed SKU.
    const ownSkus = new Set(p.variants.map((v) => v.sku));
    const psins = new Set(p.variants.map((v) => feedBySku.get(v.sku)?.psin).filter((x): x is string => !!x));
    const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+\d+$/, "").trim();
    const sources = [...byColour.entries()].map(([colour, vs]) => {
      const images = vs.flatMap((v) => feedBySku.get(v.sku)?.images ?? []);
      if (images.length || !psins.size) return { colour, images };
      for (const psin of psins) {
        const twin = (psinIndex.get(psin) ?? []).find((r) => !ownSkus.has(r.sku) && norm(L.colours.toFrenchColour(r.color)) === norm(colour));
        if (twin) return { colour, images: twin.images };
      }
      return { colour, images };
    });
    const excl = L.photos.exclusiveImages(sources);
    let uploadsPlanned = 0;

    for (const [colour, vs] of byColour) {
      const cp: ColourPlan = {
        colour, skus: vs.map((v) => v.sku), variantIds: vs.map((v) => v.id), action: "keep", status: "", reason: "", before: null,
      };
      plan.colours.push(cp);
      // The label already contradicts the supplier colour (never auto-renamed — a human decides): attaching "the photo of the
      // feed colour" would put a photo that contradicts the label. The daily variant-photo-guard reports these separately.
      const feedColours = vs.map((v) => feedBySku.get(v.sku)?.color).filter((x): x is string => !!x);
      const contradicted = feedColours.find((fc) => L.guard.labelContradicts(colour, fc));
      if (contradicted !== undefined) {
        cp.status = "label-contradiction";
        cp.reason = `libellé « ${colour} » en contradiction avec la couleur du flux « ${contradicted} » — laissé tel quel (à vérifier par un humain)`;
        continue;
      }
      const ids = new Set(vs.map((v) => v.image_id));
      if (ids.size > 1) {
        // A colour sold in several sizes may rightly show one photo per size (bird-cage case, 2026-10-20): not flattened.
        cp.status = "per-size-photos";
        cp.reason = "les variantes de cette couleur montrent des photos différentes (une par taille) — laissé tel quel";
        continue;
      }
      const curId = vs[0].image_id;
      const curImg = curId != null ? galleryById.get(curId) : undefined;
      let need: string | null = null;
      if (!curImg) { need = "aucune photo"; cp.before = null; }
      else {
        const st = await styleOf(curImg.src);
        cp.before = { src: curImg.src, style: st };
        if (st === "studio") need = "packshot fond blanc";
        else if (st === null) { cp.status = "style-unknown"; cp.reason = "style de la photo actuelle indéterminé — laissé tel quel"; continue; }
        else {
          const v = await verdictOf(curImg.src);
          if (!v) { cp.status = "vision-unknown"; cp.reason = "texte incrusté indéterminé sur la photo actuelle — laissé tel quel"; continue; }
          if (isClean(v)) { cp.status = "already-lifestyle"; cp.reason = "photo actuelle déjà lifestyle propre"; continue; }
          need = `texte incrusté (${v.reason.slice(0, 50)})`;
        }
      }
      const mine = excl.get(colour) ?? [];
      if (mine.length === 0) {
        cp.status = "no-lifestyle-exclusive";
        cp.reason = `${need} — aucune photo exclusive à cette couleur dans le flux (SKU absent du flux ou photos partagées) — photo actuelle conservée`;
        continue;
      }
      const pick = await firstCleanLifestyle(mine, MAX_STYLE_CHECKS_COLOUR, MAX_VISION_CANDIDATES_COLOUR, used, (u) => !galleryByKey.has(L.photos.imageKey(u)));
      if (!pick.url) {
        cp.status = "no-lifestyle-exclusive";
        cp.reason = `${need} — aucune photo exclusive lifestyle propre (${pick.note}) — photo actuelle conservée`;
        continue;
      }
      const k = L.photos.imageKey(pick.url);
      const g = galleryByKey.get(k);
      if (!g && gallery.length + uploadsPlanned + 1 > GALLERY_CAP) {
        cp.status = "image-cap";
        cp.reason = `galerie à ${GALLERY_CAP} images — téléversement impossible, photo actuelle conservée`;
        continue;
      }
      cp.action = "change";
      cp.status = "changed";
      cp.mode = g ? "attach" : "upload";
      cp.reason = `${need} → ${pick.note}`;
      cp.after = { src: g?.src ?? pick.url, key: k, imageId: g?.id };
      if (!g) uploadsPlanned++;
      used.add(k);
      chosen.set(k, cp);
    }
  }

  // ── pos-1 ──
  const cur = gallery[0];
  const pos1: Pos1Plan = { action: "keep", status: "", reason: "", before: null };
  plan.pos1 = pos1;
  const curStyle = await styleOf(cur.src);
  pos1.before = { src: cur.src, style: curStyle };
  let needPos1: string | null = null;
  if (curStyle === "studio") needPos1 = "packshot fond blanc";
  else if (curStyle === null) { pos1.status = "style-unknown"; pos1.reason = "style de la pos-1 indéterminé — laissée telle quelle"; }
  else {
    const v = await verdictOf(cur.src);
    if (!v) { pos1.status = "vision-unknown"; pos1.reason = "texte incrusté indéterminé sur la pos-1 — laissée telle quelle"; }
    else if (isClean(v)) {
      // A clean photo can still be a close-up (door knob, branch tips, mattress corner): the whole product must be visible.
      const full = await fullViewOf(cur.src, "lite");
      if (!full) { pos1.status = "vision-unknown"; pos1.reason = "produit entier indéterminé sur la pos-1 — laissée telle quelle"; }
      else if (full.fullProduct) { pos1.status = "already-clean-lifestyle"; pos1.reason = "pos-1 déjà lifestyle propre"; }
      else needPos1 = `pos-1 non entière (${full.reason.slice(0, 50)})`;
    }
    else needPos1 = `texte incrusté (${v.reason.slice(0, 50)})`;
  }
  if (needPos1) {
    // Gallery first (a reorder), then the feed photos of this product's SKUs (an upload). pos-1 is not colour-guarded.
    const curKey = L.photos.imageKey(cur.src);
    const galleryUrls = gallery.slice(1).map((g) => g.src);
    const feedUrls: string[] = [];
    const seen = new Set(gallery.map((g) => L.photos.imageKey(g.src)));
    for (const v of p.variants) for (const u of feedBySku.get(v.sku)?.images ?? []) {
      const k = L.photos.imageKey(u);
      if (k && !seen.has(k)) { seen.add(k); feedUrls.push(u); }
    }
    const pick = await firstCleanLifestyle([...galleryUrls, ...feedUrls], MAX_STYLE_CHECKS_POS1, MAX_VISION_CANDIDATES_POS1, new Set([curKey]), (u) => !galleryByKey.has(L.photos.imageKey(u)));
    if (!pick.url) {
      pos1.action = "none";
      pos1.status = "no-clean-lifestyle";
      pos1.reason = `${needPos1} — aucune photo lifestyle propre trouvée (${pick.note}) — pos-1 laissée telle quelle`;
    } else {
      const k = L.photos.imageKey(pick.url);
      const g = galleryByKey.get(k);
      const reused = chosen.get(k); // already needed for a colour: one upload serves both
      if (!g && !reused && gallery.length + plan.colours.filter((c) => c.mode === "upload").length + 1 > GALLERY_CAP) {
        pos1.action = "none"; pos1.status = "image-cap"; pos1.reason = `galerie à ${GALLERY_CAP} images — téléversement impossible`;
      } else {
        pos1.action = g || reused?.mode === "attach" ? "move" : "upload";
        pos1.status = "changed";
        pos1.reason = `${needPos1} → ${pick.note}`;
        pos1.after = { src: g?.src ?? pick.url, key: k, source: g ? "gallery" : "feed", imageId: g?.id };
      }
    }
  }
  plan.visionAfter = { lite: liteTotal() - plan.visionBefore.lite, strong: strongTotal() - plan.visionBefore.strong };
  return plan;
}

// ─── Backup persistence ─────────────────────────────────────────────────────────

/**
 * Every backup line goes to the worktree file AND to a durable copy outside the worktree. `strict` (the BEFORE line) aborts
 * the product if the durable copy fails — nothing may be written to Shopify without a restorable original on disk twice.
 */
function persist(line: unknown, strict = false): void {
  appendJsonl(BACKUP, line);
  try { appendJsonl(DURABLE_BACKUP, line); }
  catch (err) {
    if (strict) throw new Error(`sauvegarde durable impossible (${DURABLE_BACKUP}): ${err instanceof Error ? err.message : err}`);
    console.log(`    ⚠ copie durable impossible: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
}

// ─── Apply (one product) ────────────────────────────────────────────────────────

interface ApplyResult { ok: boolean; wrote: boolean; notes: string[] }
interface UploadRecord { imageId: number; feedUrl: string; filename: string; stem: string }

async function applyProduct(plan: ProductPlan, p: ShopProduct): Promise<ApplyResult> {
  const notes: string[] = [];
  const changes = plan.colours.filter((c) => c.action === "change");
  const pos1 = plan.pos1;
  const pos1Change = !!pos1 && (pos1.action === "move" || pos1.action === "upload");
  if (changes.length === 0 && !pos1Change) return { ok: true, wrote: false, notes: ["rien à écrire"] };
  const pid = p.id;

  // Backup BEFORE the first write (also durable, outside the worktree).
  persist({
    productId: String(pid), handle: p.handle, ts: new Date().toISOString(),
    before: {
      gallery: p.images.map((g) => ({ id: g.id, position: g.position, src: g.src, stem: stemOf(g.src) })),
      variants: p.variants.map((v) => ({ variantId: v.id, sku: v.sku, colour: [v.option1, v.option2, v.option3].filter(Boolean).join(" / "), image_id: v.image_id })),
      pos1: p.images[0] ? { imageId: p.images[0].id, src: p.images[0].src, stem: stemOf(p.images[0].src) } : null,
      tags: p.tags,
    },
  }, true);

  const uploaded: UploadRecord[] = [];
  const byKey = new Map<string, number>(); // imageKey → live image id (gallery or just uploaded)
  for (const g of p.images) { const k = L.photos.imageKey(g.src); if (k && !byKey.has(k)) byKey.set(k, g.id); }
  const prevImage = new Map(p.variants.map((v) => [v.id, v.image_id]));
  let allOk = true;

  /** Each upload is persisted the instant it lands: a later throw can never leave an unrecorded orphan image. */
  const recordUpload = (imageId: number, feedUrl: string): void => {
    const rec: UploadRecord = { imageId, feedUrl, filename: feedUrl.split("?")[0].split("/").pop() ?? "", stem: stemOf(feedUrl) };
    uploaded.push(rec);
    persist({ productId: String(pid), handle: p.handle, ts: new Date().toISOString(), uploaded: rec });
  };

  /** PUT every variant of a colour; if one fails after others succeeded, put the already-modified ones back (best effort). */
  const setColourImage = async (c: ColourPlan, imageId: number): Promise<void> => {
    const done: number[] = [];
    try {
      for (const vid of c.variantIds) {
        await rest(`/variants/${vid}.json`, "PUT", { variant: { id: vid, image_id: imageId } });
        done.push(vid);
      }
    } catch (err) {
      const stuck: number[] = [];
      for (const vid of done) {
        try { await rest(`/variants/${vid}.json`, "PUT", { variant: { id: vid, image_id: prevImage.get(vid) ?? null } }); }
        catch { stuck.push(vid); }
      }
      if (done.length) notes.push(`colour ${c.colour}: ${done.length} variante(s) remise(s) à l'ancienne image${stuck.length ? ` — ${stuck.length} NON remise(s) (${stuck.join(",")})` : ""}`);
      throw err;
    }
  };

  for (const c of changes) {
    try {
      const k = c.after!.key;
      let imageId = byKey.get(k);
      if (imageId === undefined) {
        // upload with variant_ids: attaches in the same call
        const { image, recovered } = await uploadAttachment(pid, c.after!.src, c.variantIds);
        imageId = image.id;
        byKey.set(k, image.id);
        recordUpload(image.id, c.after!.src);
        if (recovered) await setColourImage(c, image.id); // the POST's own variant attachment cannot be assumed
      } else {
        await setColourImage(c, imageId);
      }
      c.after!.imageId = imageId;
    } catch (err) {
      allOk = false;
      c.status = "apply-failed";
      c.reason += ` — ÉCHEC écriture: ${err instanceof Error ? err.message.slice(0, 160) : err}`;
      notes.push(`colour ${c.colour}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }

  if (pos1Change && pos1?.after) {
    try {
      const k = pos1.after.key;
      let imageId = byKey.get(k);
      if (imageId === undefined) {
        const { image } = await uploadAttachment(pid, pos1.after.src);
        imageId = image.id;
        byKey.set(k, image.id);
        recordUpload(image.id, pos1.after.src);
      }
      pos1.after.imageId = imageId;
      await throttle();
      const sh = unwrap(await import("@/lib/shopify-client"));
      const settled = await sh.moveImageToFirstPosition(pid, imageId);
      if (!settled) throw new Error("reorder_not_confirmed");
    } catch (err) {
      allOk = false;
      pos1!.status = "apply-failed";
      pos1!.reason += ` — ÉCHEC écriture: ${err instanceof Error ? err.message.slice(0, 160) : err}`;
      notes.push(`pos-1: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }

  // Verify by re-reading (uploads can land at the end of the gallery despite position). The final backup line is written in
  // `finally`, so a throwing read cannot lose the record of what was uploaded / mapped.
  let newPos1Src = "";
  try {
    const after = await readProduct(pid);
    if (after) {
      newPos1Src = after.images[0]?.src ?? "";
      for (const c of changes) {
        if (c.status === "apply-failed") continue;
        const bad = c.variantIds.filter((vid) => after.variants.find((v) => v.id === vid)?.image_id !== c.after!.imageId);
        if (bad.length) { allOk = false; c.status = "apply-unverified"; notes.push(`colour ${c.colour}: ${bad.length} variante(s) sans la photo attendue`); }
      }
      if (pos1Change && pos1?.after && pos1.status !== "apply-failed" && after.images[0]?.id !== pos1.after.imageId) {
        allOk = false; pos1.status = "apply-unverified"; notes.push("pos-1 non confirmée à la relecture");
      }
    } else { allOk = false; notes.push("relecture impossible"); }
  } catch (err) {
    allOk = false;
    notes.push(`relecture en échec: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  } finally {
    persist({
      productId: String(pid), handle: p.handle, ts: new Date().toISOString(),
      after: {
        uploaded,
        colourMap: changes.map((c) => ({ colour: c.colour, imageId: c.after?.imageId ?? null, variantIds: c.variantIds, status: c.status })),
        pos1: pos1Change ? { imageId: pos1.after?.imageId ?? null, src: newPos1Src, status: pos1.status } : null,
      },
    });
  }

  // Keep the nightly guards quiet — ONLY when pos-1 really changed (status "changed", i.e. written AND confirmed):
  // cache the new pos-1 verdict, stamp it as checked, and close the stale proposals.
  if (pos1Change && pos1?.after?.imageId && pos1.status === "changed" && newPos1Src) {
    const stem = stemOf(newPos1Src);
    const have = (await L.db.getCachedImageVerdicts([stem])).get(stem);
    if (!have) {
      const v = strongMemo.get(stemOf(pos1.after.src));
      if (v) await L.db.putCachedImageVerdict(stem, v, { model: `${L.models.llmModel("strong")}@${L.vision.DEFAULT_CLASSIFY_PX}`, sampleUrl: newPos1Src });
    }
    await L.db.markImageChecked([String(pid)], new Map([[String(pid), stem]]));
    const open = [...await L.db.listImageReviews("pending", 5000), ...await L.db.listImageReviews("approved", 5000)].filter((r) => r.shopifyProductId === String(pid));
    // 'applied' (supported by setImageReviewStatus): the proposal's goal — a clean pos-1 — is now live. Never 'rejected',
    // which would read as a human decision against the proposal.
    for (const r of open) await L.db.setImageReviewStatus(r.id, "applied");
    if (open.length) notes.push(`${open.length} proposition(s) image_review_queue fermée(s)`);
  }
  return { ok: allOk, wrote: true, notes };
}

// ─── Rollback ───────────────────────────────────────────────────────────────────

interface BackupLine {
  productId: string; handle: string; ts: string;
  before?: {
    gallery: Array<{ id: number; position: number; src: string; stem: string }>;
    variants: Array<{ variantId: number; sku: string; colour: string; image_id: number | null }>;
    pos1: { imageId: number; src: string; stem: string } | null;
  };
  /** One line per upload, written the instant the upload lands (survives a crash before the final `after` line). */
  uploaded?: { imageId: number; stem: string };
  after?: { uploaded: Array<{ imageId: number; stem: string }> };
}

async function rollback(target: string): Promise<void> {
  const lines = readJsonl<BackupLine>(existsSync(BACKUP) ? BACKUP : DURABLE_BACKUP);
  const byProduct = new Map<string, { before?: NonNullable<BackupLine["before"]>; uploaded: Map<number, string> }>();
  for (const l of lines) {
    const e = byProduct.get(l.productId) ?? { uploaded: new Map<number, string>() };
    if (l.before && !e.before) e.before = l.before; // the FIRST backup is the original state
    // union of the per-upload lines and the final `after` line
    if (l.uploaded) e.uploaded.set(l.uploaded.imageId, l.uploaded.stem);
    for (const u of l.after?.uploaded ?? []) e.uploaded.set(u.imageId, u.stem);
    byProduct.set(l.productId, e);
  }
  const ids = target === "all" ? [...byProduct.keys()] : [target];
  console.log(`${APPLY ? "ROLLBACK" : "ROLLBACK (dry-run)"} — ${ids.length} produit(s)`);
  for (const id of ids) {
    const e = byProduct.get(id);
    if (!e?.before) { console.log(`  ${id}: aucune sauvegarde`); continue; }
    const cur = await readProduct(id);
    if (!cur) { console.log(`  ${id}: produit introuvable`); continue; }
    const curById = new Set(cur.images.map((g) => g.id));
    const curByStem = new Map<string, number>();
    for (const g of cur.images) { const s = stemOf(g.src); if (s && !curByStem.has(s)) curByStem.set(s, g.id); }
    const oldStem = new Map(e.before.gallery.map((g) => [g.id, g.stem]));
    const resolve = (oldId: number): number | null => {
      if (curById.has(oldId)) return oldId;
      const s = oldStem.get(oldId);
      return s && curByStem.has(s) ? curByStem.get(s)! : null;
    };
    const originals = new Set(e.before.gallery.map((g) => g.id));
    let restoredVariants = 0, failed = 0;
    for (const v of e.before.variants) {
      const now = cur.variants.find((x) => x.id === v.variantId);
      if (!now) continue;
      const target = v.image_id == null ? null : resolve(v.image_id);
      if (v.image_id != null && target === null) { console.log(`    variante ${v.sku}: ancienne image introuvable`); failed++; continue; }
      if (now.image_id === target) continue;
      restoredVariants++;
      if (APPLY) {
        try { await rest(`/variants/${v.variantId}.json`, "PUT", { variant: { id: v.variantId, image_id: target } }); }
        catch (err) { failed++; console.log(`    variante ${v.sku}: ${err instanceof Error ? err.message.slice(0, 120) : err}`); }
      }
    }
    let pos1Note = "pos-1 inchangée";
    if (e.before.pos1) {
      const want = resolve(e.before.pos1.imageId);
      if (want === null) pos1Note = "ancienne pos-1 introuvable";
      else if (cur.images[0]?.id !== want) {
        pos1Note = "pos-1 restaurée";
        if (APPLY) {
          await throttle();
          const sh = unwrap(await import("@/lib/shopify-client"));
          if (!(await sh.moveImageToFirstPosition(id, want))) { pos1Note = "pos-1 NON confirmée"; failed++; }
        }
      }
    }
    // Delete ONLY what this script added (never an original: ids absent from the original gallery), including ORPHAN uploads
    // recorded by the per-upload lines of a run that crashed before its final `after` line.
    const toDelete = [...e.uploaded.keys()].filter((imgId) => curById.has(imgId) && !originals.has(imgId));
    if (APPLY) {
      for (const imgId of toDelete) {
        try { await rest(`/products/${id}/images/${imgId}.json`, "DELETE"); }
        catch (err) { failed++; console.log(`    suppression image ${imgId}: ${err instanceof Error ? err.message.slice(0, 120) : err}`); }
      }
      // The product leaves the effective `done` set so it can be re-applied (last status per id wins).
      appendJsonl(CHECKPOINT, { productId: id, handle: cur.handle, ts: new Date().toISOString(), status: failed ? "rollback-partial" : "rolled-back", notes: [] });
    }
    console.log(`  ${id} ${cur.handle}: ${restoredVariants} variante(s) restaurée(s) · ${pos1Note} · ${toDelete.length} image(s) ajoutée(s) supprimée(s)${failed ? ` · ${failed} échec(s)` : ""}`);
  }
}

// ─── Reports ────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const thumbUrl = (src: string) => (/cdn\.shopify\.com/.test(src) ? `${src}${src.includes("?") ? "&" : "?"}width=220` : src);
const img = (src: string | undefined, label: string) =>
  src ? `<a href="${esc(src)}" target="_blank"><img loading="lazy" src="${esc(thumbUrl(src))}" alt="${esc(label)}"></a>` : `<div class="none">aucune</div>`;
const STATUS_FR: Record<string, string> = {
  changed: "à changer", "already-lifestyle": "déjà lifestyle", "already-clean-lifestyle": "déjà lifestyle propre",
  "per-size-photos": "photos par taille", "no-lifestyle-exclusive": "aucune lifestyle exclusive", "no-clean-lifestyle": "aucune lifestyle propre",
  "style-unknown": "style indéterminé", "vision-unknown": "vision indéterminée", "image-cap": "plafond images",
  "apply-failed": "échec", "apply-unverified": "non vérifié", "label-contradiction": "libellé ≠ couleur du flux",
};

function buildHtml(plans: ProductPlan[], summary: Record<string, unknown>): string {
  const rows = plans.map((p) => {
    const cells: string[] = [];
    if (p.skipped) return `<section><h2>${esc(p.handle)} <small>${esc(p.skipped)}</small></h2></section>`;
    if (p.pos1) {
      cells.push(`<div class="cell ${p.pos1.status}"><h3>pos-1 — ${esc(STATUS_FR[p.pos1.status] ?? p.pos1.status)} <small>${esc(p.pos1.action)}</small></h3>
        <div class="pair"><figure>${img(p.pos1.before?.src, "avant")}<figcaption>avant (${esc(p.pos1.before?.style ?? "?")})</figcaption></figure>
        <figure>${img(p.pos1.after?.src, "après")}<figcaption>après${p.pos1.after ? ` (${p.pos1.after.source})` : ""}</figcaption></figure></div>
        <p>${esc(p.pos1.reason)}</p></div>`);
    }
    for (const c of p.colours) {
      cells.push(`<div class="cell ${c.status}"><h3>${esc(c.colour)} — ${esc(STATUS_FR[c.status] ?? c.status)}${c.mode ? ` <small>${esc(c.mode)}</small>` : ""}</h3>
        <div class="pair"><figure>${img(c.before?.src, "avant")}<figcaption>avant (${esc(c.before?.style ?? "?")})</figcaption></figure>
        <figure>${img(c.after?.src, "après")}<figcaption>après</figcaption></figure></div>
        <p>${esc(c.reason)}</p><p class="skus">${esc(c.skus.join(", "))}</p></div>`);
    }
    return `<section><h2>${esc(p.name)} <small>${esc(p.handle)} · ${p.nColours} couleur(s) · vision ${p.visionAfter.lite}+${p.visionAfter.strong}</small></h2><div class="grid">${cells.join("")}</div></section>`;
  }).join("\n");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Photos top produits — ${APPLY ? "APPLIQUÉ" : "dry-run"}</title>
<style>body{font:14px system-ui;margin:16px;background:#fafafa;color:#222}h1{font-size:20px}h2{font-size:15px;margin:24px 0 6px}small{color:#777;font-weight:400}
.grid{display:flex;flex-wrap:wrap;gap:10px}.cell{background:#fff;border:1px solid #ddd;border-radius:6px;padding:8px;width:480px}
.cell.changed{border-color:#2a9d4a}.cell.no-lifestyle-exclusive,.cell.no-clean-lifestyle{border-color:#d98c00}.cell.apply-failed,.cell.apply-unverified{border-color:#c00}
.cell h3{font-size:13px;margin:0 0 6px}.pair{display:flex;gap:8px}figure{margin:0}img{width:220px;height:220px;object-fit:contain;background:#f0f0f0;border:1px solid #eee}
figcaption{font-size:11px;color:#666}.none{width:220px;height:220px;display:flex;align-items:center;justify-content:center;background:#f0f0f0;color:#999}
p{margin:6px 0 0;font-size:12px}.skus{color:#999;font-size:11px}pre{background:#fff;border:1px solid #ddd;padding:8px;overflow:auto}</style></head><body>
<h1>Photos des produits les plus populaires — ${APPLY ? "APPLIQUÉ" : "dry-run (aucune écriture)"}</h1><pre>${esc(JSON.stringify(summary, null, 2))}</pre>${rows}</body></html>`;
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
function buildCsv(plans: ProductPlan[]): string {
  const head = ["productId", "handle", "part", "colour", "action", "status", "mode", "before_style", "before_src", "after_src", "reason"];
  const out = [head.join(",")];
  for (const p of plans) {
    if (p.pos1) out.push([p.productId, p.handle, "pos1", "", p.pos1.action, p.pos1.status, p.pos1.action, p.pos1.before?.style ?? "", p.pos1.before?.src ?? "", p.pos1.after?.src ?? "", p.pos1.reason].map(csvCell).join(","));
    for (const c of p.colours) out.push([p.productId, p.handle, "colour", c.colour, c.action, c.status, c.mode ?? "", c.before?.style ?? "", c.before?.src ?? "", c.after?.src ?? "", c.reason].map(csvCell).join(","));
  }
  return out.join("\n");
}

function summarize(plans: ProductPlan[], skipped: Array<{ id: string; why: string }>, extra: Record<string, unknown>) {
  const done = plans.filter((p) => !p.skipped);
  const pos1 = (s: (x: Pos1Plan) => boolean) => done.filter((p) => p.pos1 && s(p.pos1)).length;
  const cols = done.flatMap((p) => p.colours);
  const colStatus: Record<string, number> = {};
  for (const c of cols) colStatus[c.status] = (colStatus[c.status] ?? 0) + 1;
  return {
    mode: APPLY ? "apply" : "dry-run",
    products: { examined: done.length, skipped, multiColour: done.filter((p) => p.nColours >= 2).length },
    pos1: {
      alreadyCleanLifestyle: pos1((x) => x.status === "already-clean-lifestyle"),
      moveFromGallery: pos1((x) => x.action === "move"),
      uploadFromFeed: pos1((x) => x.action === "upload"),
      noCleanLifestyle: pos1((x) => x.status === "no-clean-lifestyle"),
      unknown: pos1((x) => x.status === "style-unknown" || x.status === "vision-unknown"),
    },
    colours: {
      total: cols.length,
      toChange: cols.filter((c) => c.action === "change").length,
      attachExisting: cols.filter((c) => c.mode === "attach").length,
      uploadFromFeed: cols.filter((c) => c.mode === "upload").length,
      byStatus: colStatus,
    },
    plannedShopifyWrites: {
      variantPuts: cols.filter((c) => c.mode === "attach").reduce((n, c) => n + c.variantIds.length, 0),
      uploads: cols.filter((c) => c.mode === "upload").length + done.filter((p) => p.pos1?.action === "upload" && !p.colours.some((c) => c.after && c.after.key === p.pos1!.after?.key)).length,
      pos1Moves: done.filter((p) => p.pos1?.action === "move" || p.pos1?.action === "upload").length,
    },
    openReviewRows: done.reduce((n, p) => n + p.openReviewRows, 0),
    counters: { ...counters },
    ...extra,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────────

interface TopEntry { id: string; handle: string; name: string; skus: string[]; demand: number; colors: string[]; nColors: number }

async function main() {
  if (!TOKEN) { console.error("SHOPIFY_ACCESS_TOKEN manquant (run avec --env-file=.env.local)"); process.exit(1); }
  L = await loadLib();
  if (ROLLBACK) { await rollback(ROLLBACK); return; }

  // The strong confirmation is a SECOND opinion only if it is a different model from the lite tier.
  if (L.models.llmModel("strong") === L.models.llmModel("lite")) {
    console.error(`llmModel("strong") === llmModel("lite") (${L.models.llmModel("lite")}) : la confirmation « strong » ne serait pas un deuxième avis. Abandon (GEMINI_API_KEY manquante ou LLM_PROVIDER=anthropic ?).`);
    process.exit(1);
  }
  // Costway products are isolated from every Aosom job (their images/SKUs are the supplier's own, opaque by design). Fail CLOSED.
  let costwayIds: Set<string>;
  try { costwayIds = await L.db.getCostwayShopifyProductIds(); }
  catch (err) {
    console.error(`getCostwayShopifyProductIds() a échoué — abandon (fail-closed): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`produits Costway exclus: ${costwayIds.size}`);

  const list = JSON.parse(readFileSync(INPUT, "utf8")) as TopEntry[];
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${list.length} produits dans la liste, start=${START}, limit=${Number.isFinite(LIMIT) ? LIMIT : "all"}, max ${MAX_SECONDS}s`);

  const catalog = await L.csv.fetchAosomCatalog();
  const feedBySku = new Map<string, { color: string; psin: string; images: string[] }>();
  const psinIndex = new Map<string, Array<{ sku: string; color: string; images: string[] }>>();
  for (const c of catalog) {
    feedBySku.set(c.sku, { color: c.color, psin: c.psin, images: c.images });
    if (c.psin) { if (!psinIndex.has(c.psin)) psinIndex.set(c.psin, []); psinIndex.get(c.psin)!.push({ sku: c.sku, color: c.color, images: c.images }); }
  }
  console.log(`flux Aosom: ${catalog.length} SKUs`);

  // LAST status per product wins: a later "failed" / "rolled-back" removes a product from the effective `done` set.
  const lastStatus = new Map<string, string>();
  if (SKIP_DONE) for (const c of readJsonl<{ productId: string; status: string }>(CHECKPOINT)) lastStatus.set(c.productId, c.status);
  const done = new Set([...lastStatus].filter(([, st]) => st === "done").map(([id]) => id));
  ensureDir(`${DIR}/x`);
  const started = Date.now();
  const plans: ProductPlan[] = [];
  const skipped: Array<{ id: string; why: string }> = [];
  let nextStart: number | null = null;
  let processed = 0;
  let applied = 0, applyFailed = 0;

  for (let i = START; i < list.length; i++) {
    const e = list[i];
    if (ONLY && !ONLY.has(e.id)) continue;
    if (processed >= LIMIT) break;
    if ((Date.now() - started) / 1000 > MAX_SECONDS) { nextStart = i; break; }
    if (done.has(e.id)) { skipped.push({ id: e.id, why: "déjà au checkpoint" }); continue; }
    if (costwayIds.has(e.id)) { skipped.push({ id: e.id, why: "produit Costway (isolé)" }); continue; }
    try {
      const p = await readProduct(e.id);
      if (!p) { skipped.push({ id: e.id, why: "introuvable sur Shopify" }); continue; }
      if (p.status !== "active") { skipped.push({ id: e.id, why: `statut ${p.status}` }); continue; }
      if (p.tags.split(",").some((t) => t.trim().toLowerCase() === "src-c")) { skipped.push({ id: e.id, why: "tag src-c (Costway)" }); continue; }
      processed++;
      console.log(`[${i}] ${p.handle} (${p.variants.length} variantes, ${p.images.length} images)`);
      const plan = await planProduct(p, feedBySku, psinIndex);
      const open = [...await L.db.listImageReviews("pending", 5000), ...await L.db.listImageReviews("approved", 5000)].filter((r) => r.shopifyProductId === plan.productId);
      plan.openReviewRows = open.length;
      plans.push(plan);
      const ch = plan.colours.filter((c) => c.action === "change").length;
      console.log(`    pos-1: ${plan.pos1?.status || plan.pos1?.action} · couleurs: ${plan.colours.length} (à changer ${ch}) · vision ${plan.visionAfter.lite}+${plan.visionAfter.strong}`);
      if (APPLY) {
        const r = await applyProduct(plan, p);
        if (r.wrote) { if (r.ok) applied++; else applyFailed++; }
        appendJsonl(CHECKPOINT, { productId: plan.productId, handle: plan.handle, ts: new Date().toISOString(), status: r.ok ? "done" : "failed", notes: r.notes });
        console.log(`    ${r.ok ? "appliqué" : "ÉCHEC partiel"}${r.notes.length ? ` — ${r.notes.join(" | ")}` : ""}`);
      }
    } catch (err) {
      skipped.push({ id: e.id, why: `erreur: ${err instanceof Error ? err.message.slice(0, 160) : err}` });
      console.log(`    ERREUR ${e.id}: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
      if (APPLY) appendJsonl(CHECKPOINT, { productId: e.id, ts: new Date().toISOString(), status: "failed", notes: [String(err).slice(0, 200)] });
    }
  }

  const summary = summarize(plans, skipped, { elapsedSeconds: Math.round((Date.now() - started) / 1000), nextStart, applied, applyFailed });
  writeFileSync(`${DIR}/${REPORT_NAME}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), summary, plans }, null, 2));
  writeFileSync(`${DIR}/${REPORT_NAME}.csv`, buildCsv(plans), "utf8");
  writeFileSync(`${DIR}/${REPORT_NAME}.html`, buildHtml(plans, summary), "utf8");
  console.log(`\nRÉSUMÉ ${APPLY ? "APPLY" : "DRY-RUN"}:\n${JSON.stringify(summary, null, 2)}`);
  if (nextStart !== null) console.log(`\nFenêtre de temps épuisée — reprendre avec --start ${nextStart}`);
  console.log(`\nRapports: ${DIR}/${REPORT_NAME}.{json,csv,html}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
