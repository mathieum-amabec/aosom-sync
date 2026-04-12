#!/usr/bin/env node
// scripts/diagnose-shopify.js
// READ-ONLY diagnostic for the Shopify store after the CSV reimport incident.
// Touches nothing. Just reports.
//
// Usage: node scripts/diagnose-shopify.js
// Requires: SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in .env.local
//           (or exported in the environment).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── env loading ─────────────────────────────────────────────────────
function loadDotenv() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotenv();

const STORE = (process.env.SHOPIFY_STORE_URL || "27u5y2-kp.myshopify.com")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2024-01";

if (!TOKEN) {
  console.error("ERROR: SHOPIFY_ACCESS_TOKEN not set in .env.local or environment");
  process.exit(1);
}

// ─── HTTP helper with pagination ─────────────────────────────────────
async function shopifyGet(endpoint) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
  });

  if (response.status === 429) {
    const retryAfter = parseFloat(response.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyGet(endpoint);
  }

  if (!response.ok) {
    throw new Error(`Shopify API ${response.status} on ${endpoint}: ${await response.text()}`);
  }

  const linkHeader = response.headers.get("link") || "";
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  const nextPageInfo = nextMatch ? new URL(nextMatch[1]).searchParams.get("page_info") : null;

  return { body: await response.json(), nextPageInfo };
}

async function fetchAllPaginated(endpoint, key) {
  const results = [];
  let pageInfo = null;
  const sep = endpoint.includes("?") ? "&" : "?";
  do {
    const ep = pageInfo ? `${endpoint}${sep}page_info=${pageInfo}&limit=250` : `${endpoint}${sep}limit=250`;
    const { body, nextPageInfo } = await shopifyGet(ep);
    if (Array.isArray(body[key])) results.push(...body[key]);
    pageInfo = nextPageInfo;
  } while (pageInfo);
  return results;
}

// ─── report helpers ──────────────────────────────────────────────────
function header(title) {
  const bar = "=".repeat(64);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

function row(label, value) {
  console.log(`  ${label.padEnd(38)} ${value}`);
}

// ─── diagnostic passes ───────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`Diagnostic starting against ${STORE} (API ${API_VERSION})`);
  console.log(`Read-only. No writes. No modifications.\n`);

  // 1. Collections
  header("1. COLLECTIONS");
  const smart = await fetchAllPaginated("/smart_collections.json", "smart_collections");
  const custom = await fetchAllPaginated("/custom_collections.json", "custom_collections");
  row("Smart collections (auto rules)", smart.length);
  row("Custom collections (manual)", custom.length);
  row("Total collections", smart.length + custom.length);

  // For each collection, count products via /collections/{id}/products.json
  // Custom collections use collects; smart collections match by rules. Both expose /products.json.
  section("Per-collection product counts");
  const allCollections = [
    ...smart.map((c) => ({ ...c, _type: "smart" })),
    ...custom.map((c) => ({ ...c, _type: "custom" })),
  ];
  const collectionCounts = new Map();
  for (const col of allCollections) {
    try {
      const countRes = await shopifyGet(`/products/count.json?collection_id=${col.id}`);
      const count = countRes.body.count ?? 0;
      collectionCounts.set(col.id, count);
      const flag = count === 0 ? "  ⚠ EMPTY" : "";
      console.log(
        `  [${col._type.padEnd(6)}] ${String(col.id).padEnd(14)} ${String(count).padStart(5)} products  ${col.title}${flag}`,
      );
    } catch (e) {
      console.log(`  [${col._type}] ${col.id} ERROR: ${e.message}`);
    }
  }

  // 2. Orphaned products
  header("2. ORPHANED PRODUCTS (not in any collection)");
  console.log("Fetching all products (paginated)...");
  const products = await fetchAllPaginated(
    "/products.json?fields=id,title,handle,status,published_at,published_scope,template_suffix,tags",
    "products",
  );
  row("Total products", products.length);

  console.log("Fetching all collects (paginated)...");
  const collects = await fetchAllPaginated("/collects.json", "collects");
  row("Total collects (custom-collection links)", collects.length);

  // Smart-collection membership: fetch each smart collection's full product list
  const smartMembership = new Set();
  for (const sc of smart) {
    try {
      const members = await fetchAllPaginated(
        `/collections/${sc.id}/products.json?fields=id`,
        "products",
      );
      for (const p of members) smartMembership.add(p.id);
    } catch (e) {
      console.log(`  (smart collection ${sc.id} member fetch failed: ${e.message})`);
    }
  }

  const customMembership = new Set(collects.map((c) => c.product_id));
  const inAnyCollection = new Set([...smartMembership, ...customMembership]);

  const orphaned = products.filter((p) => !inAnyCollection.has(p.id));
  row("Products in at least one collection", inAnyCollection.size);
  row("ORPHANED products (no collection)", orphaned.length);
  row("Orphaned %", `${((orphaned.length / Math.max(products.length, 1)) * 100).toFixed(1)}%`);

  if (orphaned.length > 0) {
    section("First 20 orphaned products");
    for (const p of orphaned.slice(0, 20)) {
      console.log(`  ${String(p.id).padEnd(14)} [${p.status}] ${(p.title || "").slice(0, 60)}`);
    }
    if (orphaned.length > 20) console.log(`  ... and ${orphaned.length - 20} more`);
  }

  // 3. Publication state
  header("3. PUBLICATION STATE");
  const publishedCount = products.filter((p) => p.published_at).length;
  const unpublishedCount = products.length - publishedCount;
  const statusActive = products.filter((p) => p.status === "active").length;
  const statusDraft = products.filter((p) => p.status === "draft").length;
  const statusArchived = products.filter((p) => p.status === "archived").length;

  row("status = active", statusActive);
  row("status = draft", statusDraft);
  row("status = archived", statusArchived);
  row("published_at set (visible)", publishedCount);
  row("published_at null (hidden)", unpublishedCount);

  // published_scope tells us which sales channels: 'web' = Online Store, 'global' = all
  section("published_scope distribution");
  const scopes = {};
  for (const p of products) {
    const s = p.published_scope || "(none)";
    scopes[s] = (scopes[s] || 0) + 1;
  }
  for (const [scope, n] of Object.entries(scopes)) {
    const warn = scope !== "web" && scope !== "global" ? "  ⚠ NOT ONLINE STORE" : "";
    row(scope, `${n}${warn}`);
  }

  // 4. Template suffixes
  header("4. TEMPLATE ASSIGNMENTS");
  const noTemplate = products.filter((p) => !p.template_suffix).length;
  const withTemplate = products.length - noTemplate;
  row("template_suffix set", withTemplate);
  row("template_suffix null/empty", `${noTemplate}  ${noTemplate === products.length ? "(all default, likely normal)" : ""}`);

  if (withTemplate > 0) {
    section("Templates in use");
    const templates = {};
    for (const p of products) {
      if (p.template_suffix) templates[p.template_suffix] = (templates[p.template_suffix] || 0) + 1;
    }
    for (const [t, n] of Object.entries(templates)) {
      row(t, n);
    }
  }

  // 5. Backup search
  header("5. BACKUP SEARCH");
  const searchDirs = [
    "/mnt/user-data/uploads",
    path.join(process.env.HOME || "", "Downloads"),
    path.join(process.env.HOME || "", "downloads"),
    path.resolve(__dirname, ".."),
  ];
  const backups = [];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const lower = e.name.toLowerCase();
        if (lower.endsWith(".csv") && (lower.includes("product") || lower.includes("shopify") || lower.includes("export"))) {
          const full = path.join(dir, e.name);
          const stat = fs.statSync(full);
          backups.push({ path: full, size: stat.size, mtime: stat.mtime });
        }
      }
    } catch {}
  }
  if (backups.length === 0) {
    console.log("  No Shopify product CSV exports found in common locations.");
    console.log("  Searched:");
    for (const d of searchDirs) console.log(`    - ${d}${fs.existsSync(d) ? "" : "  (does not exist)"}`);
    console.log("\n  If you still have the original export CSV, put it somewhere accessible");
    console.log("  and re-run this script — it will be parsed to reconstruct collection associations.");
  } else {
    console.log(`  Found ${backups.length} candidate CSV file(s):`);
    for (const b of backups.sort((a, b) => b.mtime - a.mtime)) {
      console.log(`    ${b.mtime.toISOString()}  ${(b.size / 1024).toFixed(1)}KB  ${b.path}`);
    }
    console.log("\n  Tip: the file modified BEFORE the incident is the one to use as the restore baseline.");
  }

  // 6. Summary verdict
  header("SUMMARY");
  const issues = [];
  if (orphaned.length > 0) {
    issues.push(`${orphaned.length} products have no collection (${((orphaned.length / products.length) * 100).toFixed(0)}%)`);
  }
  const emptyCollections = [...collectionCounts.entries()].filter(([, n]) => n === 0).length;
  if (emptyCollections > 0) {
    issues.push(`${emptyCollections} collections have zero products`);
  }
  if (unpublishedCount > 0) {
    issues.push(`${unpublishedCount} products are hidden (published_at null)`);
  }
  const nonWebScope = products.length - (scopes.web || 0) - (scopes.global || 0);
  if (nonWebScope > 0) {
    issues.push(`${nonWebScope} products are NOT on the Online Store sales channel`);
  }

  if (issues.length === 0) {
    console.log("  ✓ No obvious damage detected. Store state looks consistent.");
  } else {
    console.log("  Issues detected:");
    for (const i of issues) console.log(`    ⚠ ${i}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDiagnostic complete in ${elapsed}s. Read-only run — nothing modified.`);
  console.log("Next step: review the issues above and decide the restore strategy before touching anything.\n");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
