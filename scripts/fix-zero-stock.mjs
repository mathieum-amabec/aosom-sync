// scripts/fix-zero-stock.mjs
//
// One-shot: tag the 17 imported products whose Aosom stock is qty=0 with
// "out-of-stock", so they're flagged while still Published/Active. These are
// dropship products (inventory_management: null) that remain orderable on the
// storefront despite zero supplier stock — the tag is a stop-gap marker until
// the low-stock buffer / inventory tracking backfill lands.
//
// ⚠️ Shopify's REST product update REPLACES the tags field wholesale — a PUT
// with { tags: "out-of-stock" } would WIPE every existing tag. (The brief's
// literal body did exactly that.) So this script GETs the current tags first,
// APPENDS "out-of-stock" only if missing, and PUTs the MERGED set. Idempotent:
// a product that already has the tag is skipped.
//
// Does NOT archive and does NOT draft — status is left untouched (Active stays
// Active). The product keeps its listing; the tag is just a marker for now.
//
// Dry-run by default (prints before/after tags). Pass --apply to write.
// Backs up original tags to data/shopify-backup/ (gitignored) before any write.
// 2 req/sec throttle (GET + PUT per product) + 429 backoff.
//
//   node scripts/fix-zero-stock.mjs           # dry-run
//   node scripts/fix-zero-stock.mjs --apply   # write
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
const TAG = "out-of-stock";

const APPLY = process.argv.includes("--apply");

if (!TOKEN) {
  console.error("SHOPIFY_ACCESS_TOKEN missing in .env.local");
  process.exit(1);
}

// The exact 17 qty=0 imported product IDs from the audit.
const IDS = [
  "7736542429289", "7736562679913", "7736575623273", "7750877544553",
  "7751702675561", "7751702708329", "7751740981353", "7752188723305",
  "7752221425769", "7752227815529", "7752241021033", "7752242102377",
  "7788348538985", "9359738732649", "9365034958953", "9365039382633",
  "9367414603881",
];

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

// Parse Shopify's comma-separated tags string into a trimmed, non-empty array.
function parseTags(s) {
  return (s || "").split(",").map((t) => t.trim()).filter(Boolean);
}

// ── 1) Read current tags (and status) for each product ──
const plan = [];
for (const id of IDS) {
  const res = await rest(`/products/${id}.json?fields=id,title,status,tags`);
  if (!res.ok) {
    console.log(`✗ GET ${id} — HTTP ${res.status}`);
    plan.push({ id, error: `GET ${res.status}` });
    continue;
  }
  const { product } = await res.json();
  const current = parseTags(product.tags);
  const has = current.some((t) => t.toLowerCase() === TAG);
  const merged = has ? current : [...current, TAG];
  plan.push({
    id,
    title: product.title,
    status: product.status,
    from: current,
    to: merged,
    changed: !has,
  });
}

// ── 2) Report ──
const toChange = plan.filter((p) => p.changed && !p.error);
const already = plan.filter((p) => !p.changed && !p.error);
const errored = plan.filter((p) => p.error);

console.log(`\n=== fix-zero-stock ${APPLY ? "APPLY" : "DRY-RUN"} (API ${API_VERSION}) — tag "${TAG}" ===`);
console.log(`Products targeted:   ${IDS.length}`);
console.log(`Would add tag:       ${toChange.length}`);
console.log(`Already tagged:      ${already.length}`);
console.log(`GET errors:          ${errored.length}`);

console.log(`\n--- before → after (status unchanged) ---`);
for (const p of plan) {
  if (p.error) { console.log(`✗ ${p.id} — ${p.error}`); continue; }
  const mark = p.changed ? "+" : "=";
  console.log(`${mark} [${p.id}] (${p.status}) ${(p.title || "").slice(0, 50)}`);
  console.log(`    from: [${p.from.join(", ")}]`);
  console.log(`    to:   [${p.to.join(", ")}]`);
}

if (!APPLY) {
  console.log(`\nDRY-RUN only. Re-run with --apply to add "${TAG}" to ${toChange.length} products.`);
  process.exit(0);
}

// ── Backup BEFORE any write ──
const backupDir = join(__dirname, "..", "data", "shopify-backup");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `zero-stock-tags-${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify(
    { createdAt: new Date().toISOString(), api: API_VERSION, tag: TAG, products: plan.map((p) => ({ id: p.id, originalTags: p.from })) },
    null,
    2,
  ),
);
console.log(`\nBackup written: ${backupPath}`);

// ── 3) Apply: PUT the merged tag set (status left untouched) ──
console.log(`\n=== APPLYING tag to ${toChange.length} products (status unchanged) ===`);
let ok = 0;
let failed = 0;
const errors = [];
for (const p of toChange) {
  const res = await rest(`/products/${p.id}.json`, {
    method: "PUT",
    // Only `tags` is sent — status/title/etc. are untouched. tags is the FULL
    // merged set (Shopify replaces the field, so the existing tags must be included).
    body: JSON.stringify({ product: { id: Number(p.id), tags: p.to.join(", ") } }),
  });
  if (!res.ok) {
    failed++;
    const body = await res.text();
    errors.push({ id: p.id, status: res.status, body: body.slice(0, 200) });
    console.log(`✗ ${p.id} — HTTP ${res.status}`);
    continue;
  }
  const { product } = await res.json();
  ok++;
  console.log(`✓ ${p.id} (${product.status}) → tags: [${parseTags(product.tags).join(", ")}]`);
}

console.log(`\n=== DONE: ${ok} tagged, ${failed} failed, ${already.length} already had it ===`);
if (errors.length) console.log(JSON.stringify(errors, null, 2));
console.log(`Status left unchanged on all products. Backup: ${backupPath}`);
