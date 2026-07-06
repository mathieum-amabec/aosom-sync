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

const tally = {};
const nonOk = [];
let i = 0;
for (const f of feed) {
  i++;
  let r;
  try {
    const resp = await fetch(`${STOREFRONT}/products/${f.handle}`, { method: "GET", redirect: "manual", headers: { "User-Agent": "feed-diagnostic/1.0" } });
    r = { status: resp.status, loc: resp.headers.get("location") || "" };
  } catch (e) { r = { status: 0, loc: `ERR ${e.message}` }; }
  tally[r.status] = (tally[r.status] || 0) + 1;
  if (r.status !== 200) nonOk.push({ ...f, ...r });
  if (i % 100 === 0) console.log(`  ...${i}/${feed.length}  running tally ${JSON.stringify(tally)}`);
  await sleep(320);
}

console.log(`\n=== RESULT ===`);
console.log(`status tally: ${JSON.stringify(tally)}`);
console.log(`non-200 count: ${nonOk.length}`);
for (const n of nonOk.slice(0, 60)) console.log(`  [${n.status}] ${n.handle}  ${n.loc ? "→ " + n.loc.slice(0, 70) : ""}`);
if (nonOk.length > 60) console.log(`  ...and ${nonOk.length - 60} more`);
process.exit(0);
