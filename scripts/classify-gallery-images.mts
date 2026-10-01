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
 * Uses Gemini 2.5 Flash-Lite via Vercel AI Gateway (classifyProductImageGemini), not Claude:
 * ~0.40 $ for the ~10,500-image backlog vs ~18 $ on Claude's `maintenance` pool, for the
 * same validated STRICT_OVERLAY_PROMPT. See tests/vision-classifier-gemini.test.ts.
 *
 * Requires AI_GATEWAY_API_KEY (not set as of 2026-10-01 — same gap as Studio's AI retouch).
 * Add a key + Gateway credit in the Vercel dashboard, or locally in .env.local to test.
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
 *   # pilot: classify the first 100 uncached photos:
 *   …classify-gallery-images.mts --apply --limit 100
 *   # the rest, run again (and again — it only ever touches what's still uncached):
 *   …classify-gallery-images.mts --apply --limit 2000
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
const MODEL = "google/gemini-2.5-flash-lite";
/** How many classifications run at once. Gemini/Gateway rate limits for this account are
 *  unverified, so this stays conservative rather than guessed higher. */
const CONCURRENCY = 5;

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : Infinity;

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

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
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
  if (!env.hasAiGatewayKey) {
    console.log("\nABORT: AI_GATEWAY_API_KEY is not set. Add a key + Gateway credit in the Vercel");
    console.log("dashboard (or .env.local for a local run) before using --apply.");
    process.exit(1);
  }

  let done = 0, flagged = 0, errors = 0;
  await pool(toRun, CONCURRENCY, async (stem) => {
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
