// scripts/probe-ugc-paths.mjs — HEAD-probe alternate Aosom UGC CDN paths for all
// live products (shopify_product_id set). Read-only: HEAD requests only, no
// download, no DB write. Reports how many NEW clips each path pattern yields.
//
//   node-x64 --env-file=.env.local scripts/probe-ugc-paths.mjs
import { createClient } from "@libsql/client";

const HOST = "https://uspm.aosomcdn.com";
// {SKU} is replaced (upper-cased, as the known-good CA/US paths use).
// NOTE: /aosomweb/customer/FR/ is INTENTIONALLY NOT probed for sourcing — it
// exists, but every FR clip is a Skeepers influencer review (watermark + burned
// FR subtitles that say "Aosom", the forbidden supplier name). 8/8 FR rejected
// in the 2026-07-08 scan. Only CA/US/UK/DE are viable (UK/DE still need a scan).
const PATTERNS = [
  "/aosomweb/customer/UK/{SKU}.mp4",
  "/aosomweb/customer/DE/{SKU}.mp4",
  "/aosomweb/customer/AU/{SKU}.mp4",
  "/customer/AU/{SKU}.mp4",
  "/customer/UK/{SKU}.mp4",
  "/aosomweb/user/{SKU}.mp4",
  "/aosomweb/customer/{SKU}.mp4",
  "/aosomweb/ugc/{SKU}.mp4",
  "/aosomweb/review/{SKU}.mp4",
];
const CONCURRENCY = 12;
const TIMEOUT_MS = 12000;

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = await db.execute({
  sql: `SELECT UPPER(sku) sku, video_ugc FROM products
        WHERE shopify_product_id IS NOT NULL AND shopify_product_id != '' ORDER BY sku`,
});
const skus = rows.rows.map((r) => ({ sku: String(r.sku), hasUgc: !!r.video_ugc }));
const known = new Set(skus.filter((s) => s.hasUgc).map((s) => s.sku));
console.log(`Live products: ${skus.length}  |  already have video_ugc (CA/US): ${known.size}`);
console.log(`Probing ${PATTERNS.length} path patterns (HEAD only)…\n`);

async function head(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ctl.signal });
    return { ok: r.ok, status: r.status, len: Number(r.headers.get("content-length") || 0), type: r.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, status: 0, err: String(e.name || e.message) };
  } finally { clearTimeout(t); }
}

// Map: pattern → { hits:[{sku,len}], newSkus:Set }
const results = Object.fromEntries(PATTERNS.map((p) => [p, { hits: [], newSkus: new Set() }]));
const foundAnyNew = new Set();      // SKUs newly discovered on ANY alt path

// One work item per (pattern, sku).
const jobs = [];
for (const p of PATTERNS) for (const s of skus) jobs.push({ p, sku: s.sku });
let done = 0;
async function worker() {
  for (;;) {
    const job = jobs.pop();
    if (!job) return;
    const url = HOST + job.p.replace("{SKU}", job.sku);
    const r = await head(url);
    done++;
    if (done % 500 === 0) process.stdout.write(`  …${done}/${jobs.length + done - (jobs.length)} probed (${jobs.length} left)\r`);
    // Accept only real video payloads (200 + non-trivial size, not an HTML/error page).
    if (r.ok && r.len > 20000 && !/(text|html)/i.test(r.type)) {
      results[job.p].hits.push({ sku: job.sku, len: r.len });
      if (!known.has(job.sku)) { results[job.p].newSkus.add(job.sku); foundAnyNew.add(job.sku); }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n\n=== RÉSULTATS (HEAD only) ===`);
for (const p of PATTERNS) {
  const r = results[p];
  console.log(`${p.padEnd(38)} : ${String(r.hits.length).padStart(4)} hits, ${String(r.newSkus.size).padStart(4)} NOUVEAUX`);
}
console.log(`\nSKUs UGC nouveaux (hors CA/US déjà connus), tous patterns confondus : ${foundAnyNew.size}`);
// A few example URLs per productive pattern.
for (const p of PATTERNS) {
  const r = results[p];
  if (r.hits.length) {
    console.log(`\n  ${p} — exemples :`);
    for (const h of r.hits.slice(0, 5)) console.log(`    ${HOST}${p.replace("{SKU}", h.sku)}  (${(h.len / 1048576).toFixed(1)} MB)`);
  }
}
// Dump the full new-SKU list for a potential follow-up download.
if (foundAnyNew.size) {
  console.log(`\nListe complète des nouveaux SKUs :\n${[...foundAnyNew].sort().join(" ")}`);
}
