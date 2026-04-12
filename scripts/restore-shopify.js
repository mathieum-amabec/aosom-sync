#!/usr/bin/env node
// scripts/restore-shopify.js
// Republish all active products that were damaged by the CSV reimport incident.
//
// Strategy (SAFE):
//   1. Read original.csv → list of handles that should be visible (Published=TRUE/VRAI, Status=active)
//   2. Query Shopify live: for each handle, find the product and its current published_at
//   3. Skip already-published products (idempotent, re-runnable)
//   4. For the rest: PUT /products/{id}.json with { published: true, published_at: ISO-8601 now }
//   5. Batch with 500ms between requests (2 req/sec Shopify limit)
//
// Modes:
//   Default (no flag): DRY RUN. Prints what would happen, writes nothing.
//   --execute:          Actually publishes the products.
//   --verbose:          Verbose logging.
//
// Usage:
//   node scripts/restore-shopify.js               # dry run
//   node scripts/restore-shopify.js --execute     # real run

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--execute");
const VERBOSE = args.has("--verbose");
const ORIGINAL_CSV = path.join(repoRoot, "data/shopify-backup/original.csv");

// ─── env ─────────────────────────────────────────────────────────────
function loadDotenv() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const STORE = (process.env.SHOPIFY_STORE_URL || "27u5y2-kp.myshopify.com")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2024-01";

if (!TOKEN) {
  console.error("ERROR: SHOPIFY_ACCESS_TOKEN missing");
  process.exit(1);
}

// ─── Shopify API ─────────────────────────────────────────────────────
async function shopifyRequest(method, endpoint, body = null) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyRequest(method, endpoint, body);
  }
  if (!res.ok) {
    throw new Error(`Shopify ${method} ${endpoint} → ${res.status}: ${await res.text()}`);
  }

  const linkHeader = res.headers.get("link") || "";
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  const nextPageInfo = nextMatch ? new URL(nextMatch[1]).searchParams.get("page_info") : null;

  return { body: await res.json(), nextPageInfo };
}

async function fetchAllProducts() {
  const all = [];
  let pageInfo = null;
  const base = "/products.json?fields=id,handle,title,status,published_at,published_scope&limit=250";
  do {
    const ep = pageInfo ? `${base}&page_info=${pageInfo}` : base;
    const { body, nextPageInfo } = await shopifyRequest("GET", ep);
    all.push(...(body.products || []));
    pageInfo = nextPageInfo;
  } while (pageInfo);
  return all;
}

// ─── CSV parsing (handles both ; and , delimiters) ───────────────────
function readCsv(file) {
  const content = fs.readFileSync(file, "utf8");
  const firstLine = content.split(/\r?\n/)[0] || "";
  const semis = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delimiter = semis > commas ? ";" : ",";
  return parse(content, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

function extractHandles(rows) {
  // Shopify exports one row per variant. The first row per handle has the product-level fields.
  const map = new Map();
  for (const row of rows) {
    const handle = row.Handle;
    if (!handle || map.has(handle)) continue;
    map.set(handle, {
      handle,
      title: row.Title,
      published: (row.Published || "").toUpperCase(),
      status: (row.Status || "").toLowerCase(),
    });
  }
  return map;
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nShopify restore — ${EXECUTE ? "\x1b[31mEXECUTE MODE\x1b[0m" : "\x1b[32mDRY RUN\x1b[0m"}`);
  console.log(`Store: ${STORE}`);
  console.log(`CSV:   ${ORIGINAL_CSV}\n`);

  // 1. Parse original CSV → build "should be visible" set
  const rows = readCsv(ORIGINAL_CSV);
  const origProducts = extractHandles(rows);
  const shouldBeVisible = new Map();
  for (const [handle, p] of origProducts) {
    const wasPublished = p.published === "TRUE" || p.published === "VRAI";
    const isActive = p.status === "active";
    if (wasPublished && isActive) {
      shouldBeVisible.set(handle, p);
    }
  }
  console.log(`Original CSV: ${origProducts.size} products`);
  console.log(`  Should be visible (Published=TRUE/VRAI + status=active): ${shouldBeVisible.size}\n`);

  // 2. Query live Shopify
  console.log("Fetching live products from Shopify...");
  const liveProducts = await fetchAllProducts();
  console.log(`  Fetched ${liveProducts.length} live products\n`);

  const byHandle = new Map(liveProducts.map((p) => [p.handle, p]));

  // 3. Classify each target
  const toPublish = [];
  const alreadyPublished = [];
  const notFound = [];
  const draftOnLive = [];

  for (const [handle, info] of shouldBeVisible) {
    const live = byHandle.get(handle);
    if (!live) {
      notFound.push({ handle, title: info.title });
      continue;
    }
    if (live.status === "draft") {
      draftOnLive.push({ handle, title: info.title, id: live.id });
      continue;
    }
    if (live.published_at) {
      alreadyPublished.push({ handle, title: info.title, id: live.id });
      continue;
    }
    toPublish.push({ handle, title: info.title, id: live.id });
  }

  // 4. Report
  console.log("=".repeat(64));
  console.log("  RESTORE PLAN");
  console.log("=".repeat(64));
  console.log(`  Already published (skip):         ${alreadyPublished.length}`);
  console.log(`  Currently draft on live (skip):   ${draftOnLive.length}`);
  console.log(`  Not found on live (skip):         ${notFound.length}`);
  console.log(`  TO REPUBLISH:                     \x1b[33m${toPublish.length}\x1b[0m`);
  console.log("=".repeat(64));

  if (VERBOSE && toPublish.length > 0) {
    console.log("\nFirst 20 to republish:");
    for (const p of toPublish.slice(0, 20)) {
      console.log(`  ${String(p.id).padEnd(14)} ${(p.title || "").slice(0, 60)}`);
    }
    if (toPublish.length > 20) console.log(`  ... and ${toPublish.length - 20} more`);
  }

  if (draftOnLive.length > 0 && VERBOSE) {
    console.log("\nSkipped (draft on live — would need manual activation):");
    for (const p of draftOnLive.slice(0, 10)) {
      console.log(`  ${String(p.id).padEnd(14)} ${(p.title || "").slice(0, 60)}`);
    }
  }

  if (notFound.length > 0) {
    console.log(`\n⚠ ${notFound.length} products from CSV not found on live store — deleted or handle changed?`);
    if (VERBOSE) {
      for (const p of notFound.slice(0, 10)) console.log(`  ${p.handle}  (${(p.title || "").slice(0, 50)})`);
    }
  }

  if (toPublish.length === 0) {
    console.log("\n✓ Nothing to republish. All target products already visible.\n");
    return;
  }

  if (!EXECUTE) {
    console.log("\n\x1b[32mDRY RUN — no changes made.\x1b[0m");
    console.log("To actually republish, run:");
    console.log(`  node scripts/restore-shopify.js --execute\n`);
    return;
  }

  // 5. Execute
  console.log(`\n\x1b[31mEXECUTING — publishing ${toPublish.length} products...\x1b[0m\n`);
  const nowIso = new Date().toISOString();
  let success = 0;
  let failures = 0;
  const errors = [];

  for (let i = 0; i < toPublish.length; i++) {
    const p = toPublish[i];
    try {
      await shopifyRequest("PUT", `/products/${p.id}.json`, {
        product: {
          id: p.id,
          published: true,
          published_at: nowIso,
          published_scope: "global",
        },
      });
      success++;
      const pct = (((i + 1) / toPublish.length) * 100).toFixed(0);
      process.stdout.write(`  [${pct}%] ${success} published, ${failures} errors\r`);
    } catch (e) {
      failures++;
      errors.push({ handle: p.handle, id: p.id, error: e.message });
    }
    // Rate limit: 2 req/sec bucket = 500ms between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n\nDone. Published: ${success}, Errors: ${failures}`);
  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const e of errors) console.log(`  ${e.handle} (${e.id}): ${e.error}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
