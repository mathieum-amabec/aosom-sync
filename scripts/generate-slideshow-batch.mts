#!/usr/bin/env tsx
/**
 * scripts/generate-slideshow-batch.mts
 *
 * Batch slideshow generator. Selects products from Turso per series, renders the
 * videos with the REAL slideshow engine (Module A) / remix engine (Module F) via
 * local FFmpeg, uploads each MP4 to the PUBLIC Vercel Blob store, and enqueues a
 * status='draft' row into publication_queue for manual approval in /videos.
 *
 * EXTENSION: this imports the project's TypeScript engine, so it's a `.mts` (not
 * `.mjs`). A native-ESM `.mjs` can't import tsx-transpiled `.ts` modules
 * reliably, and `.mjs` isn't covered by tsconfig (no type-check). `.mts` is the
 * codebase convention for engine-importing scripts and IS type-checked by tsc.
 *
 * IMPORTS: the engine functions are loaded via DYNAMIC import (loadLib), not
 * static named imports. The app's larger modules have circular import graphs that
 * make Node's static named-export detection fail nondeterministically under tsx;
 * dynamic import resolves the live module objects after load and sidesteps it.
 *
 * Run under x64 Node (libsql/sharp/ffmpeg-static have no win-arm64 build), with
 * prod creds from .env.local, THROUGH the tsx CLI:
 *
 *   # dry-run (default — selects + prints, renders/writes nothing):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/generate-slideshow-batch.mts
 *   # render everything, upload to Blob, create draft queue rows:
 *   …node_modules/tsx/dist/cli.mjs scripts/generate-slideshow-batch.mts --apply
 *   # one series only / cap the number of series (for testing):
 *   …generate-slideshow-batch.mts --series rabais-top5-1
 *   …generate-slideshow-batch.mts --apply --limit 3
 *
 * IMAGES: only cdn.shopify.com images are used (the catalog's Aosom-CDN URLs 403
 * the render workers). A product with no Shopify-CDN image is skipped + warned.
 */
import { createClient } from "@libsql/client";
import type { ProductItem } from "@/lib/selectors/types";
import type { SlideshowTemplate, SlideshowItem, SlideshowRatio } from "@/lib/slideshow/types";
import type { RemixClip } from "@/lib/slideshow/remix";

/** Cast a template literal to the nominal enum type (runtime value is the string). */
const T = (s: string): SlideshowTemplate => s as unknown as SlideshowTemplate;

/** Dynamically load the engine functions from their concrete modules. */
async function loadLib() {
  const [bs, bis, pd, ls, wd, sea, bsk, buildM, valM, remRenderM, remSelM, capM, hooksM, unsplashM] = await Promise.all([
    import("@/lib/selectors/best-sellers"),
    import("@/lib/selectors/best-seller-image-series"),
    import("@/lib/selectors/price-drops"),
    import("@/lib/selectors/low-stock"),
    import("@/lib/selectors/wow-discovery"),
    import("@/lib/selectors/seasonal"),
    import("@/lib/selectors/by-skus"),
    import("@/lib/slideshow/build"),
    import("@/lib/slideshow/validate"),
    import("@/lib/slideshow/remix/render"),
    import("@/lib/slideshow/remix/selector"),
    import("@/lib/slideshow/captions"),
    import("@/lib/slideshow/hooks"),
    import("@/lib/unsplash"),
  ]);
  return {
    bestSellers: bs.bestSellers,
    bestSellerImageSeries: bis.bestSellerImageSeries,
    priceDrops: pd.priceDrops,
    lowStock: ls.lowStock,
    wowDiscovery: wd.wowDiscovery,
    seasonal: sea.seasonal,
    productsBySkus: bsk.productsBySkus,
    buildSlideshow: buildM.buildSlideshow,
    isShopifyCdnUrl: valM.isShopifyCdnUrl,
    renderRemix: remRenderM.renderRemix,
    selectRemixClips: remSelM.selectRemixClips,
    getSlideshowCaption: capM.getSlideshowCaption,
    getSlideshowHook: hooksM.getSlideshowHook,
    getSlogan: hooksM.getSlogan,
    searchImages: unsplashM.searchImages,
    triggerDownload: unsplashM.triggerDownload,
  };
}
type Lib = Awaited<ReturnType<typeof loadLib>>;

// ── Types ──────────────────────────────────────────────────────────────────
type SeriesType =
  | "best_sellers" | "showcase" | "by_like" | "seasonal"
  | "price_drops" | "low_stock" | "wow_discovery" | "remix";

interface Series {
  id: string;
  type: SeriesType;
  ratio: SlideshowRatio;
  duration: number;
  limit?: number;
  threshold?: number;
  theme?: string;
  strategy?: "margin" | "new" | "random";
  patterns?: string[];
  sku?: string;
  /** Hook category for the intro card (getSlideshowHook). 'slogan'/'lifestyle'
   * use hookText instead. */
  hook?: string;
  /** Explicit hook seed for slogan (Claude-refined) / lifestyle (hero overlay). */
  hookText?: string;
  /** Lifestyle hero: Unsplash search query for the opening full-bleed slide. */
  unsplashQuery?: string;
}

interface ReportRow {
  id: string;
  type: string;
  count: number;
  duration?: number;
  blobUrl?: string;
  queueId?: number;
  scheduledAt?: string;
  status: string;
}

// ── CLI ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flagValue = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const ONLY_SERIES = flagValue("--series");
const SERIES_LIMIT = flagValue("--limit") ? Number(flagValue("--limit")) : null;

const BRAND = "ameublo" as const;
const LANGUAGE = "fr" as const;

// ── Static series config (showcase is generated dynamically below) ─────────
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

// Quality v2: every series ≤15s and ≤5 products (3-5 slides + intro + outro keeps
// the Reel punchy ~10-15s), with a marketing hook (never the technical id).
const STATIC_CONFIG: Series[] = [
  // best sellers (random sample from the velocity pool → varied each run)
  ...range(1, 5).map((n): Series => ({ id: `best-sellers-${n}`, type: "best_sellers", limit: 5, ratio: "9:16", duration: 15, hook: "best_sellers" })),
  // ride-on / cars for kids (fuzzy product_type)
  ...range(1, 3).map((n): Series => ({ id: `enfants-voitures-${n}`, type: "by_like", patterns: ["%Ride%", "%Car%", "%Toy Vehicle%"], limit: 5, ratio: "9:16", duration: 15, hook: "kids_cars" })),
  // kids toys (Qaba)
  ...range(1, 3).map((n): Series => ({ id: `enfants-jouets-${n}`, type: "by_like", patterns: ["%Toy%", "%Kids%", "%Baby%"], limit: 5, ratio: "9:16", duration: 15, hook: "kids_toys" })),
  // summer seasonal
  ...range(1, 3).map((n): Series => ({ id: `saison-ete-${n}`, type: "seasonal", theme: "ete", limit: 5, ratio: "9:16", duration: 15, hook: "seasonal_ete" })),
  // top discounts
  ...range(1, 3).map((n): Series => ({ id: `rabais-top5-${n}`, type: "price_drops", limit: 5, ratio: "9:16", duration: 15, hook: "price_drops" })),
  // low stock urgency
  ...range(1, 3).map((n): Series => ({ id: `urgence-stock-${n}`, type: "low_stock", threshold: 5, limit: 5, ratio: "9:16", duration: 15, hook: "low_stock" })),
  // thematic remix of the demand-gen library
  { id: "remix-ete-cour", type: "remix", theme: "ete-cour", ratio: "9:16", duration: 15, hook: "seasonal_ete" },
  { id: "remix-maison", type: "remix", theme: "maison", ratio: "9:16", duration: 15, hook: "best_sellers" },
  { id: "remix-enfants", type: "remix", theme: "enfants", ratio: "9:16", duration: 15, hook: "kids_toys" },
  // WoW discovery
  { id: "decouverte-margin-1", type: "wow_discovery", strategy: "margin", limit: 5, ratio: "9:16", duration: 15, hook: "wow_discovery" },
  { id: "decouverte-new", type: "wow_discovery", strategy: "new", limit: 5, ratio: "9:16", duration: 15, hook: "wow_discovery" },
  // office (Vinsetto)
  ...range(1, 2).map((n): Series => ({ id: `bureau-${n}`, type: "by_like", patterns: ["%Office%", "%Desk%"], limit: 5, ratio: "9:16", duration: 15, hook: "office" })),

  // ── Top 3 (short, punchy) ──
  { id: "top3-must-have", type: "best_sellers", limit: 3, ratio: "9:16", duration: 10, hook: "top3" },
  { id: "top3-maison", type: "by_like", patterns: ["%Furniture%"], limit: 3, ratio: "9:16", duration: 10, hook: "top3" },
  { id: "top3-enfants", type: "by_like", patterns: ["%Kids%", "%Toy%", "%Baby%"], limit: 3, ratio: "9:16", duration: 10, hook: "top3" },
  { id: "top3-rabais", type: "price_drops", limit: 3, ratio: "9:16", duration: 10, hook: "top3" },

  // ── Emotional slogans (hook refined by Claude) ──
  { id: "slogan-budget", type: "best_sellers", limit: 4, ratio: "9:16", duration: 15, hook: "slogan", hookText: "Tu veux mettre plus d'argent de côté mais tu dois remeubler ?" },
  { id: "slogan-ete", type: "seasonal", theme: "ete", limit: 4, ratio: "9:16", duration: 15, hook: "slogan", hookText: "L'été québécois est court — profites-en à fond 🌞" },
  { id: "slogan-bureau", type: "by_like", patterns: ["%Office%", "%Desk%"], limit: 4, ratio: "9:16", duration: 15, hook: "slogan", hookText: "Ton bureau à la maison mérite mieux que ça 💻" },

  // ── Lifestyle (Unsplash hero opener, then products) ──
  { id: "lifestyle-terrasse", type: "seasonal", theme: "ete", limit: 4, ratio: "9:16", duration: 15, hook: "lifestyle", unsplashQuery: "sunny patio terrace summer", hookText: "☀️ Ta terrasse de rêve t'attend..." },
  { id: "lifestyle-salon", type: "by_like", patterns: ["%Furniture%"], limit: 4, ratio: "9:16", duration: 15, hook: "lifestyle", unsplashQuery: "cozy modern living room interior", hookText: "🏡 Un salon qui te ressemble..." },
  { id: "lifestyle-bureau", type: "by_like", patterns: ["%Office%", "%Desk%"], limit: 4, ratio: "9:16", duration: 15, hook: "lifestyle", unsplashQuery: "modern home office workspace", hookText: "💼 Ton espace de travail idéal..." },
];

/** Seasonal theme → fuzzy product_type LIKE patterns (the catalog uses
 * 'Patio Furniture' etc., so the seasonal() selector's exact match misses them). */
const SEASONAL_PATTERNS: Record<string, string[]> = {
  ete: ["%Patio%", "%Garden%", "%Outdoor%", "%Pool%"],
  rentree: ["%Office%", "%Desk%", "%Storage%", "%Kids%"],
  "fete-peres": ["%Outdoor%", "%BBQ%", "%Tool%", "%Grill%"],
  hiver: ["%Indoor%", "%Heating%", "%Christmas%"],
  maison: ["%Indoor%", "%Storage%", "%Decor%"],
};

const TEMPLATE_FOR_TYPE: Record<string, SlideshowTemplate> = {
  best_sellers: T("BEST_SELLERS"),
  showcase: T("SHOWCASE"),
  by_like: T("LOOKBOOK"),
  seasonal: T("COUNTDOWN"),
  price_drops: T("PRICE_DROP"),
  low_stock: T("URGENCY"),
  wow_discovery: T("DISCOVERY"),
};

// ── Helpers ──────────────────────────────────────────────────────────────
/** Fisher-Yates sample of `n` items (Math.random ok — this is a one-shot script). */
function sample<U>(arr: U[], n: number): U[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
const sqliteToUnixSec = (s: string): number => Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);

let directClient: ReturnType<typeof createClient> | null = null;
function direct() {
  if (!directClient) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing (run with --env-file=.env.local)");
    directClient = createClient({ url, authToken });
  }
  return directClient;
}

/** SKUs of imported products whose product_type matches ANY of the LIKE patterns. */
async function skusByLike(patterns: string[], poolSize: number): Promise<string[]> {
  const where = patterns.map(() => "product_type LIKE ?").join(" OR ");
  const res = await direct().execute({
    sql: `SELECT sku FROM products
          WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''
            AND (${where})
          ORDER BY qty DESC LIMIT ?`,
    args: [...patterns, poolSize],
  });
  return res.rows.map((r) => String((r as unknown as Record<string, unknown>).sku));
}

/** A ProductItem from a showcase series also carries every angle. */
type ShowcaseProduct = ProductItem & { allImages: string[] };

interface Selection {
  products?: ProductItem[];
  clips?: RemixClip[];
}

/**
 * Select rows for a series. `resolveImages` is false for the dry-run (fast, no
 * Shopify calls) and true for a real render (needs cdn.shopify URLs).
 */
async function selectForSeries(series: Series, resolveImages: boolean, lib: Lib): Promise<Selection> {
  const limit = series.limit ?? 8;
  switch (series.type) {
    case "best_sellers": {
      const pool = await lib.bestSellers({ limit: 40, language: LANGUAGE, resolveImages });
      return { products: sample(pool, limit) };
    }
    case "showcase": {
      const s = series.sku ? await lib.bestSellerImageSeries(series.sku) : null;
      return { products: s ? [s] : [] };
    }
    case "by_like": {
      const skus = await skusByLike(series.patterns ?? [], limit * 4);
      const items = await lib.productsBySkus(skus, { language: LANGUAGE, resolveImages });
      return { products: sample(items, limit) };
    }
    case "seasonal": {
      // The seasonal() selector exact-matches product_type ('Patio'), but the real
      // catalog uses values like 'Patio Furniture', so it returns nothing. Match
      // the theme's product_types fuzzily (LIKE) here instead.
      const patterns = SEASONAL_PATTERNS[series.theme ?? ""] ?? [];
      if (patterns.length === 0) {
        return { products: await lib.seasonal(series.theme ?? "", { limit, language: LANGUAGE, resolveImages }) };
      }
      const skus = await skusByLike(patterns, limit * 4);
      const items = await lib.productsBySkus(skus, { language: LANGUAGE, resolveImages });
      return { products: sample(items, limit) };
    }
    case "price_drops":
      return { products: await lib.priceDrops({ limit, language: LANGUAGE, minPct: 10, resolveImages }) };
    case "low_stock":
      return { products: await lib.lowStock({ limit, language: LANGUAGE, threshold: series.threshold ?? 5, resolveImages }) };
    case "wow_discovery":
      return { products: await lib.wowDiscovery({ limit, language: LANGUAGE, strategy: series.strategy ?? "margin", resolveImages }) };
    case "remix": {
      const clips = await lib.selectRemixClips({ theme: series.theme ?? "", ratio: series.ratio, brand: BRAND, language: LANGUAGE, max_clips: 8 });
      return { clips };
    }
    default:
      return {};
  }
}

/** Map a ProductItem to a render-safe SlideshowItem (cdn.shopify image), or null. */
function toSlide(p: ProductItem, lib: Lib): SlideshowItem | null {
  const image_url = p.images.find(lib.isShopifyCdnUrl);
  if (!image_url) return null;
  return { image_url, overlay_text: p.title_fr || p.title_en || p.sku, price: p.price, compare_at: p.compare_at_price, sku: p.sku };
}

/** Compute a tentative video slot + enqueue a draft row. Returns {queueId, scheduledAt} or null. */
async function enqueueDraft(
  serieId: string,
  blobUrl: string,
  items: SlideshowItem[],
  template: SlideshowTemplate,
  lib: Lib,
): Promise<{ queueId: number; scheduledAt: string } | null> {
  const { addToQueue, getOccupiedQueueSlots, getSetting } = await import("@/lib/database");
  const { getNextAvailableSlot, parseVideoSchedule } = await import("@/lib/publication-scheduler");
  const platform = "both" as const;
  const videoSchedule = parseVideoSchedule(await getSetting("video_schedule"));
  const nowSec = Math.floor(Date.now() / 1000);
  const occupied = (await getOccupiedQueueSlots(platform, "video")).map(sqliteToUnixSec);
  const slot = await getNextAvailableSlot("facebook", {}, { nowSec, occupied, schedule: videoSchedule, contentType: "video" });
  if (!slot) return null;
  const caption = lib.getSlideshowCaption(template, LANGUAGE, items);
  const contentId = `slideshow:batch:${serieId}`;
  // Replace only a prior unapproved DRAFT for this series — never an already-
  // approved 'pending' post (re-running the batch must not silently un-schedule it).
  await direct().execute({
    sql: `UPDATE publication_queue SET status='cancelled'
          WHERE content_type='video' AND content_id=? AND status='draft'`,
    args: [contentId],
  });
  const queueId = await addToQueue({
    contentType: "video",
    contentId,
    platform,
    payload: JSON.stringify({ caption, brand: BRAND, reelsVideoUrl: blobUrl }),
    scheduledAt: slot.sqlite,
    status: "draft",
  });
  return { queueId, scheduledAt: slot.sqlite };
}

/** Display hook (no Claude call) — the intro card line, never the series id. */
function previewHook(series: Series, lib: Lib): string {
  if (series.hook === "slogan" || series.hook === "lifestyle") {
    return series.hookText ?? lib.getSlideshowHook("best_sellers", LANGUAGE);
  }
  return lib.getSlideshowHook(series.hook ?? "best_sellers", LANGUAGE);
}

/** Final hook for a real render — refines a slogan seed via Claude (fallback to seed). */
async function finalHook(series: Series, lib: Lib): Promise<string> {
  if (series.hook === "slogan") return lib.getSlogan(series.hookText ?? "", LANGUAGE);
  return previewHook(series, lib);
}

/**
 * Lifestyle opener: an Unsplash full-bleed hero slide with the hookText overlay.
 * Returns null (→ products lead) when not a lifestyle series, no query, no
 * UNSPLASH_ACCESS_KEY, or the search fails.
 */
async function fetchLifestyleHero(series: Series, lib: Lib): Promise<SlideshowItem | null> {
  if (series.hook !== "lifestyle" || !series.unsplashQuery) return null;
  if (!process.env.UNSPLASH_ACCESS_KEY) {
    console.warn("    ⚠ UNSPLASH_ACCESS_KEY absent — pas de hero lifestyle, les produits ouvrent la vidéo");
    return null;
  }
  try {
    const imgs = await lib.searchImages(series.unsplashQuery, 1);
    const hit = imgs[0];
    if (!hit?.url) return null;
    // Unsplash API guideline: ping the download endpoint when a photo is USED.
    await lib.triggerDownload(hit.downloadLocation);
    return { image_url: hit.url, overlay_text: series.hookText ?? "", price: 0, hero: true };
  } catch (err) {
    console.warn(`    ⚠ Unsplash a échoué (${err instanceof Error ? err.message : String(err)}) — pas de hero`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n🎬 Slideshow batch — ${APPLY ? "APPLY (render + upload + draft rows)" : "DRY-RUN (no render, no writes)"}\n`);
  const lib = await loadLib();

  // Resolve the dynamic showcase series (top 5 SKUs by 14-day velocity).
  const topSellers = await lib.bestSellers({ limit: 5, language: LANGUAGE, resolveImages: false });
  const showcaseSeries: Series[] = topSellers.map((p): Series => ({ id: `showcase-${p.sku}`, type: "showcase", sku: p.sku, ratio: "9:16", duration: 15, hook: "best_sellers" }));

  let config: Series[] = [...STATIC_CONFIG.slice(0, 5), ...showcaseSeries, ...STATIC_CONFIG.slice(5)];
  if (ONLY_SERIES) config = config.filter((s) => s.id === ONLY_SERIES);
  if (SERIES_LIMIT) config = config.slice(0, SERIES_LIMIT);
  if (config.length === 0) {
    console.error(ONLY_SERIES ? `No series with id '${ONLY_SERIES}'.` : "No series to run.");
    process.exit(1);
  }

  const report: ReportRow[] = [];
  for (const series of config) {
    const template = TEMPLATE_FOR_TYPE[series.type] ?? T("BEST_SELLERS");
    try {
      const selection = await selectForSeries(series, APPLY, lib);

      // ----- REMIX -----
      if (series.type === "remix") {
        const clips = selection.clips ?? [];
        console.log(`▸ ${series.id}  [remix:${series.theme}]  ${clips.length} clip(s)`);
        clips.forEach((c, i) => console.log(`    ${i + 1}. ${c.sku.padEnd(14)} ${c.duration_sec}s  ${c.title_fr ?? ""}`));
        if (clips.length === 0) { report.push({ id: series.id, type: "remix", count: 0, status: "skip (no clips)" }); continue; }
        if (!APPLY) { report.push({ id: series.id, type: "remix", count: clips.length, duration: series.duration, status: "dry-run" }); continue; }
        const res = await lib.renderRemix({ theme: series.theme ?? "", ratio: series.ratio, brand: BRAND, language: LANGUAGE, dryRun: false });
        const items: SlideshowItem[] = clips.map((c) => ({ image_url: "", overlay_text: c.title_fr ?? c.sku, price: 0 }));
        const enq = res.blobUrl ? await enqueueDraft(series.id, res.blobUrl, items, T("REMIX"), lib) : null;
        report.push({ id: series.id, type: "remix", count: clips.length, blobUrl: res.blobUrl, queueId: enq?.queueId, status: enq ? "draft" : "rendered (not queued)" });
        continue;
      }

      // ----- SLIDESHOW -----
      const products = selection.products ?? [];
      console.log(`▸ ${series.id}  [${series.type}]  ${products.length} produit(s)`);
      console.log(`    🎬 Hook: "${previewHook(series, lib)}"${series.hook === "lifestyle" ? `  (+ hero Unsplash: ${series.unsplashQuery})` : ""}`);
      products.forEach((p, i) => {
        const disc = typeof p.discount_pct === "number" && p.discount_pct >= 10 ? `  -${p.discount_pct}%` : "";
        console.log(`    ${i + 1}. ${String(p.sku).padEnd(14)} ${Number(p.price).toFixed(2)}$${disc}  ${p.title_fr ?? ""}`);
      });
      if (products.length === 0) { report.push({ id: series.id, type: series.type, count: 0, status: "skip (no products)" }); continue; }

      if (!APPLY) {
        report.push({ id: series.id, type: series.type, count: products.length, duration: series.duration, status: "dry-run" });
        continue;
      }

      // Build render-safe slides (cdn.shopify only). For showcase, expand the SKU's angles.
      let slides: SlideshowItem[];
      let candidateCount: number;
      if (series.type === "showcase") {
        const s = products[0] as ShowcaseProduct;
        const angles = (s?.allImages ?? []).filter(lib.isShopifyCdnUrl);
        slides = angles.slice(0, 8).map((image_url) => ({ image_url, overlay_text: s.title_fr || s.sku, price: s.price, compare_at: s.compare_at_price, sku: s.sku }));
        // The 8-slide cap is a deliberate trim, not a missing-image skip; only warn
        // about genuinely cdn-less angles. Suppress the generic skip warning below.
        candidateCount = slides.length;
        const noCdn = (s?.allImages?.length ?? 0) - angles.length;
        if (noCdn > 0) console.warn(`    ⚠ ${noCdn} image(s) sans cdn.shopify.com — ignorée(s)`);
      } else {
        candidateCount = products.length;
        slides = products.map((p) => toSlide(p, lib)).filter((x): x is SlideshowItem => x !== null);
      }
      const skipped = candidateCount - slides.length;
      if (skipped > 0) console.warn(`    ⚠ ${skipped} produit(s)/image(s) sans image cdn.shopify.com — ignoré(s)`);
      if (slides.length === 0) { report.push({ id: series.id, type: series.type, count: 0, status: "skip (no cdn.shopify image)" }); continue; }

      // Lifestyle: prepend an Unsplash full-bleed hero slide (falls back to products).
      const hero = await fetchLifestyleHero(series, lib);
      if (hero) slides = [hero, ...slides];

      const built = await lib.buildSlideshow(template, {
        items: slides,
        ratio: series.ratio,
        brand: BRAND,
        language: LANGUAGE,
        durationSec: series.duration,
        title: await finalHook(series, lib), // marketing hook on the intro card
        dryRun: false,
      });
      const blobUrl = built.result.blobUrl;
      const enq = blobUrl ? await enqueueDraft(series.id, blobUrl, slides, template, lib) : null;
      report.push({ id: series.id, type: series.type, count: slides.length, blobUrl, queueId: enq?.queueId, scheduledAt: enq?.scheduledAt, status: enq ? "draft" : "rendered (not queued)" });
    } catch (err) {
      console.error(`  ✗ ${series.id}: ${err instanceof Error ? err.message : String(err)}`);
      report.push({ id: series.id, type: series.type, count: 0, status: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ── Summary ──
  console.log(`\n=== RÉCAPITULATIF (${report.length} séries) ===`);
  console.log("Série".padEnd(26) + "Type".padEnd(14) + "Prod".padEnd(6) + "Durée".padEnd(7) + "Status");
  for (const r of report) {
    console.log(
      String(r.id).padEnd(26) + String(r.type).padEnd(14) + String(r.count).padEnd(6) + String(r.duration ?? "-").padEnd(7) + r.status,
    );
  }
  if (APPLY) {
    console.log("\n--- Vidéos générées (blobUrl / queueId) ---");
    for (const r of report.filter((x) => x.blobUrl)) {
      console.log(`${r.id}: queueId=${r.queueId ?? "-"} ${r.blobUrl}`);
    }
    console.log("\nApprouve les drafts dans /videos → File d'attente pour les planifier.");
  } else {
    console.log("\nDry-run terminé. Relance avec --apply pour générer, uploader et créer les drafts.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFATAL:", err);
    process.exit(1);
  });
