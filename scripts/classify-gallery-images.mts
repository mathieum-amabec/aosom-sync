#!/usr/bin/env tsx
/**
 * scripts/classify-gallery-images.mts
 *
 * Closes the gap the daily pos-1 guard (image-compliance.ts) never covers: it only ever
 * classifies position 1 and whatever alternatives it scans hunting for a replacement.
 * Measured against the live catalog on 2026-10-01: position 1 is 96.5% classified,
 * positions 2+ — everything an ad feed's `additional_image_link` actually serves — only
 * 15.9%. This script classifies the rest, writing into the SAME `image_classifications`
 * cache (by Aosom hash stem — see imageUrlStem), so the feed layer (feeds/source.ts) treats
 * a verdict from here exactly like one from the daily guard; no caller-side branching.
 *
 * Uses Gemini (classifyProductImageGemini) direct to Google — NOT Claude, and NOT Vercel AI
 * Gateway: Google's own API gives this a genuine free tier at our volume, so the operator
 * added Google Cloud billing (prepay) instead of a second Vercel billing relationship.
 * Rough cost either way: ~1-2 $ for the whole ~10,500-image backlog vs ~18 $ on Claude's
 * `maintenance` pool, for the same validated STRICT_OVERLAY_PROMPT. See
 * tests/vision-classifier-gemini.test.ts.
 *
 * Requires GEMINI_API_KEY (direct Google API key — generativelanguage.googleapis.com, from
 * https://aistudio.google.com/apikey, NOT a Vercel AI Gateway key). Add it to .env.local for
 * a local run, or to the Vercel project's env vars for a deployed one.
 *
 * Rate-limited and capped deliberately: this is this project's first-ever real call to this
 * API, so REQUESTS_PER_SECOND stays conservative and --limit defaults to a small pilot-sized
 * batch rather than the whole backlog, until a run has actually been reviewed.
 *
 * DRY RUN by default: fetches every active+published product's gallery, reports how many
 * distinct photos are already cached vs still need a verdict, and classifies NOTHING.
 * --apply classifies the uncached ones (checkpoint-free by construction: each verdict is
 * written to Turso as soon as it's produced via putCachedImageVerdict, so killing the job
 * loses nothing and re-running just skips whatever got cached already).
 *
 * Run under x64 Node (libsql has no win-arm64 build), with prod creds, through tsx:
 *
 *   # see the plan, classify nothing:
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/classify-gallery-images.mts
 *   # pilot: classify the first 50 uncached photos (the default --limit if omitted):
 *   …classify-gallery-images.mts --apply
 *   # a bigger batch once the pilot looks right:
 *   …classify-gallery-images.mts --apply --limit=2000
 */
// tsx may surface a CommonJS module's named exports under `default` — every import below
// goes through this fallback so the script works whether tsx resolves ESM or CJS.
import * as configNs from "../src/lib/config";
import * as visionNs from "../src/lib/vision-classifier";
import * as auditNs from "../src/lib/image-compliance-audit";
import * as dbNs from "../src/lib/database";
type ConfigMod = typeof import("../src/lib/config");
type VisionMod = typeof import("../src/lib/vision-classifier");
type AuditMod = typeof import("../src/lib/image-compliance-audit");
type DbMod = typeof import("../src/lib/database");
const { env } = (configNs as unknown as { default?: ConfigMod }).default ?? (configNs as unknown as ConfigMod);
const { classifyProductImageGemini } = (visionNs as unknown as { default?: VisionMod }).default ?? (visionNs as unknown as VisionMod);
const { imageUrlStem } = (auditNs as unknown as { default?: AuditMod }).default ?? (auditNs as unknown as AuditMod);
const { getCachedImageVerdicts, putCachedImageVerdict } = (dbNs as unknown as { default?: DbMod }).default ?? (dbNs as unknown as DbMod);

const SHOPIFY_STORE = "27u5y2-kp.myshopify.com";
const SHOPIFY_API_VERSION = "2025-01";
const MODEL = "gemini-3.5-flash-lite"; // label stored in image_classifications.model

/** Requests per second. Deliberately conservative: this project has never made a single
 *  successful call against this Google Cloud project's real (billed) quota — tune up once a
 *  real run confirms Google isn't throttling at this rate. */
const REQUESTS_PER_SECOND = 2;
/** Default --limit when none is given. A first-ever run against a brand-new integration
 *  gets a small, reviewable batch, not the whole backlog — raise it explicitly once a pilot
 *  has been checked (see scripts/classify-gallery-images.mts's module doc). */
const DEFAULT_LIMIT = 50;

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : DEFAULT_LIMIT;

interface ShopifyImage { id?: number | string | null; src: string }
interface ShopifyProduct { id: number | string; status: string; published_at: string | null; images?: ShopifyImage[] }

function parseNextPageInfo(link: string | null): string | null {
  if (!link) return null;
  const part = link.split(",").find((s) => s.includes('rel="next"'));
  const m = part && /<([^>]+)>/.exec(part);
  return m ? new URL(m[1]).searchParams.get("page_info") : null;
}

async function fetchAllActiveImages(): Promise<{ sku: string; stem: string; url: string }[]> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not set");
  const base = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
  const out: { sku: string; stem: string; url: string }[] = [];
  let pageInfo: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,status,published_at,images" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await fetch(`${base}/products.json?${params}`, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = (await res.json()) as { products: ShopifyProduct[] };
    for (const p of data.products) {
      if (p.status !== "active" || !p.published_at) continue;
      for (const img of p.images ?? []) {
        const stem = imageUrlStem(img.src);
        if (stem) out.push({ sku: String(p.id), stem, url: img.src });
      }
    }
    pageInfo = parseNextPageInfo(res.headers.get("Link"));
  } while (pageInfo);
  return out;
}

/** Runs `fn` over `items` in windows of at most `perSecond` concurrent calls, pacing each
 *  window to take at least one second — a real requests-per-second cap, not just a bounded
 *  concurrency pool (which could burst far above perSecond/s if each call completes fast). */
async function rateLimited<T>(items: T[], perSecond: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += perSecond) {
    const chunk = items.slice(i, i + perSecond);
    const startedAt = Date.now();
    await Promise.all(chunk.map(fn));
    const remaining = 1000 - (Date.now() - startedAt);
    if (remaining > 0 && i + perSecond < items.length) await new Promise((r) => setTimeout(r, remaining));
  }
}

async function main() {
  console.log("fetching every active+published product's gallery...");
  const images = await fetchAllActiveImages();
  const byStem = new Map<string, string>(); // stem -> one sample url
  for (const i of images) if (!byStem.has(i.stem)) byStem.set(i.stem, i.url);
  const allStems = [...byStem.keys()];
  console.log(`${images.length} image rows, ${allStems.length} distinct photos (by Aosom hash stem)`);

  const cached = await getCachedImageVerdicts(allStems);
  const uncachedStems = allStems.filter((s) => !cached.has(s));
  console.log(`already classified: ${cached.size} (${(cached.size / allStems.length * 100).toFixed(1)}%)`);
  console.log(`still need a verdict: ${uncachedStems.length}`);

  const toRun = uncachedStems.slice(0, LIMIT);
  console.log(`this run would classify: ${toRun.length}${LIMIT < Infinity ? ` (--limit ${LIMIT})` : ""}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing classified, nothing written. --apply to run for real.");
    process.exit(0);
  }
  if (!env.hasGeminiKey) {
    console.log("\nABORT: GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey");
    console.log("and add it to .env.local (or the Vercel project's env vars) before using --apply.");
    process.exit(1);
  }

  let done = 0, flagged = 0, errors = 0;
  await rateLimited(toRun, REQUESTS_PER_SECOND, async (stem) => {
    const url = byStem.get(stem)!;
    try {
      const verdict = await classifyProductImageGemini(url);
      await putCachedImageVerdict(stem, verdict, { model: MODEL, sampleUrl: url });
      done++;
      if (!verdict.compliant) { flagged++; console.log(`  non-compliant: ${stem} — ${verdict.reason}`); }
    } catch (err) {
      errors++;
      console.error(`  ERROR ${stem}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  console.log(`\nclassified ${done}/${toRun.length} (${flagged} flagged non-compliant, ${errors} errors)`);
  console.log(`remaining after this run: ${uncachedStems.length - done}`);
}

await main();
