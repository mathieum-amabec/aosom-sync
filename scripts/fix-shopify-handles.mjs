// scripts/fix-shopify-handles.mjs
//
// De-brand Shopify product handles: remove "aosom" from product URL handles so
// storefront/feed links no longer embed the supplier name (Projet #1, suite).
//
// DRY-RUN BY DEFAULT — prints the transformations and never writes.
// Pass --apply to perform the PUTs.
//
// ⚠️ Shopify does NOT auto-create a redirect when the handle is changed via the
// REST Admin API (that auto-behavior only fires from the Online Store admin UI).
// Verified live 2026-06-17: API rename → old URL 404, no redirect. So on --apply
// this script EXPLICITLY creates a 301 (POST /redirects.json path → target) after
// each rename, using the handle Shopify actually stored (may be -1 on collision).
//
// Transform (widened per Mat's checkpoint decision to cover prefix/suffix too,
// so all "aosom" handles are de-branded, not just the dash-wrapped ones):
//   newHandle = handle
//     .replace(/(^|-)aosom(-|$)/g, '$1$2')  // strips -aosom-, aosom-, -aosom
//     .replace(/--+/g, '-')
//     .replace(/^-|-$/g, '')
//
// Rate limit: 2 req/sec STRICT — a global throttle enforces >=500ms between ANY
// two Admin API calls (reads included), plus Retry-After backoff on 429.
//
// Usage:
//   node scripts/fix-shopify-handles.mjs              # dry-run, all matches
//   node scripts/fix-shopify-handles.mjs --limit 10   # dry-run, first 10
//   node scripts/fix-shopify-handles.mjs --apply       # APPLY the renames
//   node scripts/fix-shopify-handles.mjs --apply --limit 25
//
// Reads SHOPIFY_ACCESS_TOKEN from ../.env.local (via _shopify-lib loadEnv).

import { loadEnv, sleep } from "./_shopify-lib.mjs";

const STORE = "27u5y2-kp.myshopify.com";
const API_VERSION = "2024-01"; // imposé par le brief
const TOKEN = loadEnv().SHOPIFY_ACCESS_TOKEN;
const RATE_MS = 500; // 2 req/sec strict

const APPLY = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const LIMIT = li >= 0 ? parseInt(process.argv[li + 1], 10) : Infinity;

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
    .replace(/(^|-)aosom(-|$)/g, "$1$2") // -aosom- , aosom- (prefix), -aosom (suffix)
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── 1) Page through ALL products (read-only) ──
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

// ── 2) Build the work list + flag edge cases ──
const matches = products.filter((p) => /aosom/i.test(p.handle || ""));

const plan = matches.map((p) => {
  const to = newHandle(p.handle);
  return {
    id: p.id,
    title: p.title,
    from: p.handle,
    to,
    changed: to !== p.handle,
    residualAosom: /aosom/i.test(to), // regex missed it (e.g. prefix/suffix "aosom" without both dashes)
  };
});

// Collision detection: proposed handle equals a *different* existing product's handle,
// or two proposed handles collide with each other. Shopify would suffix "-1" on apply.
const proposedCounts = new Map();
for (const r of plan) proposedCounts.set(r.to, (proposedCounts.get(r.to) || 0) + 1);
for (const r of plan) {
  const collidesExisting = r.changed && existingHandles.has(r.to);
  const collidesProposed = proposedCounts.get(r.to) > 1;
  r.collision = collidesExisting || collidesProposed;
}

const toChange = plan.filter((r) => r.changed);
const unchanged = plan.filter((r) => !r.changed);
const residuals = plan.filter((r) => r.residualAosom);
const collisions = plan.filter((r) => r.collision);

// ── 3) Report ──
console.log(`\n=== fix-shopify-handles ${APPLY ? "APPLY" : "DRY-RUN"} (API ${API_VERSION}) ===`);
console.log(`Total products:            ${products.length}`);
console.log(`Handles containing "aosom":${matches.length}`);
console.log(`Would change:              ${toChange.length}`);
console.log(`Unchanged (regex no-match):${unchanged.length}  <- "aosom" not wrapped by dashes`);
console.log(`Residual "aosom" after fix:${residuals.length}  <- still branded, regex missed`);
console.log(`Collisions (→ Shopify -1): ${collisions.length}`);
if (Number.isFinite(LIMIT)) console.log(`--limit ${LIMIT} applied`);

console.log(`\n--- first 10 transformations ---`);
toChange.slice(0, 10).forEach((r, i) => {
  console.log(`${i + 1}. ${r.from}\n   → ${r.to}${r.collision ? "   ⚠ COLLISION" : ""}`);
});

if (unchanged.length) {
  console.log(`\n--- ${unchanged.length} unchanged (need a wider rule if you want them too) ---`);
  unchanged.slice(0, 5).forEach((r) => console.log(`   • ${r.from}`));
}
if (collisions.length) {
  console.log(`\n--- ${collisions.length} collisions (Shopify will append -1) ---`);
  collisions.slice(0, 5).forEach((r) => console.log(`   • ${r.from} → ${r.to}`));
}

// ── 4) Apply ──
if (!APPLY) {
  console.log(`\nDRY-RUN only. Re-run with --apply to perform ${toChange.length} renames.`);
  process.exit(0);
}

const work = toChange.slice(0, LIMIT);
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
  const actual = product.handle; // Shopify may have suffixed -1 on collision
  ok++;

  // Explicitly create the 301 (API rename does NOT auto-redirect).
  const redRes = await rest(`/redirects.json`, {
    method: "POST",
    body: JSON.stringify({ redirect: { path: `/products/${r.from}`, target: `/products/${actual}` } }),
  });
  let redNote;
  if (redRes.ok) {
    redNote = "301 ✓";
  } else if (redRes.status === 422) {
    redNote = "301 exists"; // path already redirected (re-run) — fine
  } else {
    redNote = `301 FAILED ${redRes.status}`;
    redirectFails++;
    errors.push({ id: r.id, from: r.from, redirectStatus: redRes.status, body: (await redRes.text()).slice(0, 200) });
  }
  console.log(`✓ ${r.from} → ${actual}${actual !== r.to ? `  (proposé: ${r.to})` : ""}  [${redNote}]`);
}

console.log(`\n=== DONE: ${ok} renamed, ${failed} failed, ${redirectFails} redirects failed ===`);
if (errors.length) console.log(JSON.stringify(errors, null, 2));
console.log(`Each rename created an explicit 301 redirect (path → target). Re-runs skip existing redirects (422).`);
