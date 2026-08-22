// READ-ONLY: HTTP-check EVERY current Google-feed URL against the live storefront.
// Ground truth for "Product page unavailable". No Turso, no writes. process.exit at end.
import { rest, loadEnv, sleep } from "./_shopify-lib.mjs";
loadEnv();
const STOREFRONT = "https://ameublodirect.ca";

function parseNext(link) {
  if (!link) return null;
  const m = link.split(",").find((s) => s.includes('rel="next"'));
  const u = m && /<([^>]+)>/.exec(m);
  return u ? new URL(u[1]).searchParams.get("page_info") : null;
}

// Reproduce feed products (same filters as source.ts)
const feed = [];
let pageInfo = null, pages = 0;
do {
  const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,status,published_at,images,variants" });
  if (pageInfo) params.set("page_info", pageInfo);
  const res = await rest(`/products.json?${params}`);
  if (!res.ok) throw new Error(`Shopify ${res.status}`);
  const { products } = await res.json();
  for (const p of products) {
    if (p.status !== "active") continue;
    if (!p.published_at || new Date(p.published_at).getTime() > Date.now()) continue;
    if (!p.handle) continue;
    if (!(p.images ?? []).some((i) => i.src)) continue;
    if (!(p.variants ?? []).some((v) => v.sku && String(v.sku).trim() && (parseFloat(v.price ?? "0") || 0) > 0)) continue;
    feed.push({ handle: p.handle, title: p.title });
  }
  pageInfo = parseNext(res.headers.get("Link"));
  pages++;
  await sleep(550);
} while (pageInfo && pages < 80);

console.log(`Feed products to check: ${feed.length}\n`);

const PACING_MS = 320;
const MAX_429_RETRIES = 5;

// A 429 is the storefront throttling US — it is NOT "product page unavailable".
// Counting it as one would manufacture exactly the false positive this script
// exists to rule out (an 8-way parallel burst once returned 1055/1096 as 429).
// So: retry on 429 honouring Retry-After, and keep anything still throttled
// after the retries in its own bucket, out of the non-200 tally.
async function check(handle) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      const resp = await fetch(`${STOREFRONT}/products/${handle}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(20000), headers: { "User-Agent": "feed-diagnostic/1.0" } });
      r = { status: resp.status, loc: resp.headers.get("location") || "", retryAfter: parseFloat(resp.headers.get("Retry-After") || "") };
    } catch (e) { return { status: 0, loc: `ERR ${e.message}` }; }
    if (r.status !== 429 || attempt >= MAX_429_RETRIES) return r;
    const waitSec = Number.isNaN(r.retryAfter) ? Math.min(2 ** attempt, 30) : Math.min(r.retryAfter, 60);
    await sleep(waitSec * 1000);
  }
}

const tally = {};
const nonOk = [];
const throttled = [];
let i = 0;
for (const f of feed) {
  i++;
  const r = await check(f.handle);
  tally[r.status] = (tally[r.status] || 0) + 1;
  if (r.status === 429) throttled.push({ ...f, ...r });
  else if (r.status !== 200) nonOk.push({ ...f, ...r });
  if (i % 100 === 0) console.log(`  ...${i}/${feed.length}  running tally ${JSON.stringify(tally)}`);
  await sleep(PACING_MS);
}

console.log(`\n=== RESULT ===`);
console.log(`status tally: ${JSON.stringify(tally)}`);
console.log(`non-200 count (throttled excluded): ${nonOk.length}`);
for (const n of nonOk.slice(0, 60)) console.log(`  [${n.status}] ${n.handle}  ${n.loc ? "→ " + n.loc.slice(0, 70) : ""}`);
if (nonOk.length > 60) console.log(`  ...and ${nonOk.length - 60} more`);
if (throttled.length) {
  console.log(`\n!! ${throttled.length} URLs still rate-limited (429) after ${MAX_429_RETRIES} retries.`);
  console.log(`   These are NOT dead pages — the sweep above is INCOMPLETE. Re-run later,`);
  console.log(`   or raise PACING_MS (currently ${PACING_MS}ms) and try again.`);
}
process.exit(0);
