// scripts/probe-ugc-countries.mjs — READ-ONLY: probe every remaining customer country
// for live Shopify SKUs that have no products.video_ugc yet. HEAD only, no download.
//
//   node-x64 --env-file=.env.local scripts/probe-ugc-countries.mjs
//
// Phase A of probe-aosom-new-videos.mjs covered CA only. This covers US/UK/DE/FR so the
// true "new UGC clip" count is known. FR is probed for REPORTING only — sourcing policy
// excludes it (every FR clip is a Skeepers influencer review with the supplier name burned
// into the subtitles; 8/8 rejected in the 2026-07-08 scan).
//
// 403 = missing key (S3 without list permission), NOT a block. Only 200 + video/* counts.
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";

const HOST = "https://uspm.aosomcdn.com";
const COUNTRIES = ["US", "UK", "DE", "FR"]; // CA already done in phase A
const CONCURRENCY = 16;
const TIMEOUT_MS = 15000;

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const noUgc = (await db.execute(`
  SELECT UPPER(sku) sku FROM products
  WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''
    AND (video_ugc IS NULL OR TRIM(video_ugc) = '') ORDER BY sku`)).rows.map((r) => String(r.sku));

console.log(`SKUs live sans video_ugc : ${noUgc.length}`);
console.log(`Pays sondés : ${COUNTRIES.join(", ")}  (${noUgc.length * COUNTRIES.length} sondes HEAD)\n`);

async function head(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ctl.signal });
    return { status: r.status, len: Number(r.headers.get("content-length") || 0), type: r.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, len: 0, type: "", err: String(e.name || e.message) };
  } finally { clearTimeout(t); }
}
const isHit = (r) => r.status === 200 && r.len > 20000 && /video/i.test(r.type);

const jobs = [];
for (const c of COUNTRIES) for (const sku of noUgc) jobs.push({ c, sku, url: `${HOST}/aosomweb/customer/${c}/${sku}.mp4` });

const byCountry = Object.fromEntries(COUNTRIES.map((c) => [c, []]));
let i = 0, done = 0;
const worker = async () => {
  for (;;) {
    const j = jobs[i++];
    if (!j) return;
    const r = await head(j.url);
    done++;
    if (done % 500 === 0 || done === jobs.length) process.stdout.write(`  ${done}/${jobs.length}\r`);
    if (isHit(r)) byCountry[j.c].push({ sku: j.sku, len: r.len, url: j.url });
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n\n");

const mb = (n) => (n / 1048576).toFixed(2);
for (const c of COUNTRIES) {
  byCountry[c].sort((a, b) => a.sku.localeCompare(b.sku));
  console.log(`${c} : ${byCountry[c].length} clips  (${mb(byCountry[c].reduce((a, b) => a + b.len, 0))} MB)`);
}

// Union across the newly-probed countries, and the union INCLUDING phase A's CA hits.
const CA_HITS = JSON.parse(process.env.CA_HITS_JSON || "[]");
const union = new Set([...CA_HITS, ...COUNTRIES.flatMap((c) => byCountry[c].map((h) => h.sku))]);
console.log(`\nSKUs distincts avec au moins un clip (CA inclus) : ${union.size}`);
const sourceable = new Set([...CA_HITS, ...["US", "UK", "DE"].flatMap((c) => byCountry[c].map((h) => h.sku))]);
console.log(`SKUs sourçables (CA/US/UK/DE, FR exclu)          : ${sourceable.size}`);
const frOnly = byCountry.FR.map((h) => h.sku).filter((s) => !sourceable.has(s));
console.log(`SKUs disponibles UNIQUEMENT en FR (non sourçables) : ${frOnly.length}`);

writeFileSync("docs/probe-ugc-countries.json", JSON.stringify({ byCountry, caHits: CA_HITS, union: [...union].sort(), sourceable: [...sourceable].sort(), frOnly }, null, 2));
console.log(`\n→ docs/probe-ugc-countries.json`);
