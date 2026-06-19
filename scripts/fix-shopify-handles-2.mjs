// scripts/fix-shopify-handles-2.mjs
//
// De-brand Shopify product handles, ROUND 2: remove "outsunny" / "qaba" from
// product URL handles so storefront + Google/feed links no longer embed the
// supplier name. Follow-up to scripts/fix-shopify-handles.mjs (PR #208, which
// only stripped "aosom"). Google feed audit found 160 handles still branded
// (outsunny ×113, qaba ×47).
//
// DRY-RUN BY DEFAULT — prints transformations and writes nothing.
// Pass --apply to perform the PUTs.
//
// ⚠️ Shopify does NOT auto-create a redirect when the handle is changed via the
// REST Admin API — that auto-behavior only fires from the Online Store admin UI
// (verified live 2026-06-17 by the round-1 script: API rename → old URL 404, no
// redirect). The brief assumed auto-301s; that is WRONG for the API. So on
// --apply this script EXPLICITLY creates a 301 (POST /redirects.json,
// path → target) after each rename, using the handle Shopify actually stored
// (may be "-1"-suffixed on collision). Re-runs skip existing redirects (422).
//
// Transform (dash-anchored, same shape as round 1 so prefix/suffix/embedded all
// covered; case-insensitive, global for handles carrying both brands):
//   newHandle = handle
//     .replace(/(^|-)(outsunny|qaba)(-|$)/gi, '$1$3')
//     .replace(/--+/g, '-')
//     .replace(/^-|-$/g, '')
//
// Backup: before any write, --apply dumps the full work list (id, title, from,
// to) to data/shopify-backup/handles-round2-<ts>.json (gitignored) so the
// original handles can be restored / the 301s rebuilt if needed.
//
// Rate limit: 2 req/sec STRICT — a global throttle enforces >=500ms between ANY
// two Admin API calls (reads included), plus Retry-After backoff on 429.
//
// Usage:
//   node scripts/fix-shopify-handles-2.mjs              # dry-run, all matches
//   node scripts/fix-shopify-handles-2.mjs --limit 10   # dry-run, first 10
//   node scripts/fix-shopify-handles-2.mjs --apply       # APPLY the renames
//   node scripts/fix-shopify-handles-2.mjs --apply --limit 25
//
// Run under x64 node (see CLAUDE.md "Windows ARM64"). Reads SHOPIFY_ACCESS_TOKEN
// from ../.env.local via _shopify-lib loadEnv.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv, sleep } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STORE = "27u5y2-kp.myshopify.com";
const API_VERSION = "2025-01"; // matches _shopify-lib + the rest of the app
const TOKEN = loadEnv().SHOPIFY_ACCESS_TOKEN;
const RATE_MS = 500; // 2 req/sec strict
const BRAND_RE = /(^|-)(outsunny|qaba)(-|$)/gi;

const APPLY = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const LIMIT = li >= 0 ? Math.max(0, parseInt(process.argv[li + 1], 10) || 0) : Infinity;

if (!TOKEN) {
  console.error("SHOPIFY_ACCESS_TOKEN missing in .env.local");
  process.exit(1);
}

// ── Global throttle: >=RATE_MS between any two API calls ──
let lastCall = 0;
async function throttle() {
  const wait = Math.max(0, lastCall + RATE_MS - Date.now());
  if (wait) await sleep(wait);
  lastCall = Date.now();
}

async function rest(endpoint, options = {}, attempt = 0) {
  await throttle();
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
      ...(options.headers || {}),
    },
  });
  if (res.status === 429 && attempt < 6) {
    const waitS = Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 30);
    console.warn(`  429 — backing off ${waitS}s`);
    await sleep(waitS * 1000);
    return rest(endpoint, options, attempt + 1);
  }
  return res;
}

function parseNextPageInfo(link) {
  if (!link) return null;
  const next = link.split(",").find((s) => s.includes('rel="next"'));
  if (!next) return null;
  const u = /<([^>]+)>/.exec(next);
  return u ? new URL(u[1]).searchParams.get("page_info") : null;
}

function newHandle(h) {
  return h
    .replace(BRAND_RE, "$1$3")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchAllProducts() {
  const all = [];
  let pageInfo = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,handle,title" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await rest(`/products.json?${params}`);
    if (!res.ok) throw new Error(`products fetch failed: ${res.status} ${await res.text()}`);
    const { products } = await res.json();
    all.push(...products);
    pageInfo = parseNextPageInfo(res.headers.get("Link"));
    pages++;
  } while (pageInfo && pages < 50);
  return all;
}

const products = await fetchAllProducts();
const existingHandles = new Set(products.map((p) => p.handle));

// matches: reset lastIndex each test (BRAND_RE is global → stateful in .test()).
const matches = products.filter((p) => {
  BRAND_RE.lastIndex = 0;
  return BRAND_RE.test(p.handle || "");
});

const plan = matches.map((p) => {
  const to = newHandle(p.handle);
  BRAND_RE.lastIndex = 0;
  const residual = /(outsunny|qaba)/i.test(to);
  return { id: p.id, title: p.title, from: p.handle, to, changed: to !== p.handle, residual };
});

// Collision detection: proposed handle equals a different existing product's
// handle, or two proposals collide. Shopify would suffix "-1" on apply.
const proposedCounts = new Map();
for (const r of plan) proposedCounts.set(r.to, (proposedCounts.get(r.to) || 0) + 1);
for (const r of plan) {
  r.collision = (r.changed && existingHandles.has(r.to)) || proposedCounts.get(r.to) > 1;
}

const toChange = plan.filter((r) => r.changed);
const unchanged = plan.filter((r) => !r.changed);
const residuals = plan.filter((r) => r.residual);
const collisions = plan.filter((r) => r.collision);

console.log(`\n=== fix-shopify-handles-2 ${APPLY ? "APPLY" : "DRY-RUN"} (API ${API_VERSION}) ===`);
console.log(`Total products:              ${products.length}`);
console.log(`Handles w/ outsunny|qaba:    ${matches.length}`);
console.log(`Would change:                ${toChange.length}`);
console.log(`Unchanged (regex no-match):  ${unchanged.length}  <- brand not dash-anchored`);
console.log(`Residual brand after fix:    ${residuals.length}  <- still branded, regex missed`);
console.log(`Collisions (-> Shopify -1):  ${collisions.length}`);
if (Number.isFinite(LIMIT)) console.log(`--limit ${LIMIT} applied`);

console.log(`\n--- first 10 transformations ---`);
toChange.slice(0, 10).forEach((r, i) => {
  console.log(`${i + 1}. ${r.from}\n   -> ${r.to}${r.collision ? "   ⚠ COLLISION" : ""}`);
});
if (unchanged.length) {
  console.log(`\n--- ${unchanged.length} unchanged (brand not dash-wrapped) ---`);
  unchanged.slice(0, 5).forEach((r) => console.log(`   • ${r.from}`));
}
if (collisions.length) {
  console.log(`\n--- ${collisions.length} collisions (Shopify appends -1) ---`);
  collisions.slice(0, 5).forEach((r) => console.log(`   • ${r.from} -> ${r.to}`));
}

if (!APPLY) {
  console.log(`\nDRY-RUN only. Re-run with --apply to perform ${toChange.length} renames.`);
  process.exit(0);
}

// ── Backup BEFORE any write ──
const work = toChange.slice(0, LIMIT);
const backupDir = join(__dirname, "..", "data", "shopify-backup");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `handles-round2-${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify({ createdAt: new Date().toISOString(), api: API_VERSION, count: work.length, renames: work }, null, 2),
);
console.log(`\nBackup written: ${backupPath} (${work.length} originals)`);

console.log(`\n=== APPLYING ${work.length} renames (2 calls/product: PUT handle + POST redirect, >=${RATE_MS}ms apart) ===`);
let ok = 0;
let failed = 0;
let redirectFails = 0;
const errors = [];
for (const r of work) {
  const res = await rest(`/products/${r.id}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: { id: r.id, handle: r.to } }),
  });
  if (!res.ok) {
    failed++;
    const body = await res.text();
    errors.push({ id: r.id, from: r.from, status: res.status, body: body.slice(0, 200) });
    console.log(`✗ ${r.from} — HTTP ${res.status}`);
    continue;
  }
  const { product } = await res.json();
  const actual = product.handle; // may be "-1"-suffixed on collision
  ok++;

  const redRes = await rest(`/redirects.json`, {
    method: "POST",
    body: JSON.stringify({ redirect: { path: `/products/${r.from}`, target: `/products/${actual}` } }),
  });
  let redNote;
  if (redRes.ok) {
    redNote = "301 ✓";
  } else if (redRes.status === 422) {
    redNote = "301 exists";
  } else {
    redNote = `301 FAILED ${redRes.status}`;
    redirectFails++;
    errors.push({ id: r.id, from: r.from, redirectStatus: redRes.status, body: (await redRes.text()).slice(0, 200) });
  }
  console.log(`✓ ${r.from} -> ${actual}${actual !== r.to ? `  (proposed: ${r.to})` : ""}  [${redNote}]`);
}

console.log(`\n=== DONE: ${ok} renamed, ${failed} failed, ${redirectFails} redirects failed ===`);
if (errors.length) console.log(JSON.stringify(errors, null, 2));
console.log(`Backup of originals: ${backupPath}`);
