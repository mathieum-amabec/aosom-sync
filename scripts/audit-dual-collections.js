#!/usr/bin/env node
// scripts/audit-dual-collections.js
// READ-ONLY audit for dual-collection-assignment feature.
// Touches NOTHING. Just reads Shopify + Turso and reports.
//
// Reports:
//   1A. Shopify collections with heuristic main/sub classification
//   1B. Aosom product_type hierarchy from Turso live DB, cross-referenced
//       with existing collection_mappings
//   1C. Live Shopify product collection membership (0/1/2+ collections)
//   + Summary of work that would be needed for dual assignment

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── env loading ─────────────────────────────────────────────────────
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
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const API_VERSION = "2024-01";

if (!SHOPIFY_TOKEN) {
  console.error("ERROR: SHOPIFY_ACCESS_TOKEN missing");
  process.exit(1);
}
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("ERROR: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}

// ─── Shopify helper ──────────────────────────────────────────────────
async function shopifyGet(endpoint) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${endpoint}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_TOKEN },
  });
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyGet(endpoint);
  }
  if (!res.ok) throw new Error(`Shopify GET ${endpoint} → ${res.status}: ${await res.text()}`);
  const linkHeader = res.headers.get("link") || "";
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  const nextPageInfo = nextMatch ? new URL(nextMatch[1]).searchParams.get("page_info") : null;
  return { body: await res.json(), nextPageInfo };
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

// ─── Heuristic classification ────────────────────────────────────────
// A collection is a "main" candidate if:
//   - it has an image AND/OR
//   - its title is short and generic (1-3 words, no " et " conjunction)
// Otherwise it's a "sub" candidate.
function classifyCollection(col) {
  const hasImage = !!(col.image && col.image.src);
  const title = col.title || "";
  const wordCount = title.trim().split(/\s+/).length;
  const hasConjunction = / et | de | pour /.test(title); // French sub-collection signals
  const isShortGeneric = wordCount <= 3 && !hasConjunction;

  if (hasImage && isShortGeneric) return { type: "main", confidence: "high", reasons: ["has image", "short/generic title"] };
  if (hasImage) return { type: "main", confidence: "medium", reasons: ["has image"] };
  if (isShortGeneric) return { type: "main", confidence: "medium", reasons: ["short/generic title (no image)"] };
  return { type: "sub", confidence: "medium", reasons: ["specific title with conjunction or multi-word"] };
}

// ─── report helpers ──────────────────────────────────────────────────
function header(title) {
  const bar = "=".repeat(72);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}
function section(title) { console.log(`\n--- ${title} ---`); }

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`Dual-collection audit — ${STORE}`);
  console.log(`Turso: ${TURSO_URL}`);
  console.log(`READ-ONLY. No writes. No modifications.\n`);

  // ─── 1A. Shopify Collections ────────────────────────────────────
  header("1A. SHOPIFY COLLECTIONS");
  const smart = await fetchAllPaginated("/smart_collections.json", "smart_collections");
  const custom = await fetchAllPaginated("/custom_collections.json", "custom_collections");
  console.log(`Smart collections: ${smart.length}`);
  console.log(`Custom collections: ${custom.length}`);
  console.log(`Total: ${smart.length + custom.length}\n`);

  // Get product count per collection
  const allCollections = [
    ...smart.map((c) => ({ ...c, _type: "smart" })),
    ...custom.map((c) => ({ ...c, _type: "custom" })),
  ];
  for (const col of allCollections) {
    const { body } = await shopifyGet(`/products/count.json?collection_id=${col.id}`);
    col._productCount = body.count ?? 0;
    const cls = classifyCollection(col);
    col._class = cls;
  }

  // Sort: mains first (populated then empty), subs after
  const mains = allCollections.filter((c) => c._class.type === "main");
  const subs = allCollections.filter((c) => c._class.type === "sub");
  mains.sort((a, b) => b._productCount - a._productCount);
  subs.sort((a, b) => b._productCount - a._productCount);

  section("MAIN candidates (proposed — heuristic, YOU VALIDATE)");
  for (const col of mains) {
    const img = col.image?.src ? "✓ image" : "✗ no image";
    const flag = col._productCount === 0 ? "  ⚠ EMPTY" : "";
    console.log(
      `  [main ${col._class.confidence.padEnd(6)}] ${String(col.id).padEnd(14)} ${String(col._productCount).padStart(4)} products  ${col.title.padEnd(44)} (${img})${flag}`,
    );
  }

  section("SUB candidates (proposed — heuristic, YOU VALIDATE)");
  for (const col of subs) {
    const img = col.image?.src ? "✓ image" : "✗ no image";
    const flag = col._productCount === 0 ? "  ⚠ EMPTY" : "";
    console.log(
      `  [sub  ${col._class.confidence.padEnd(6)}] ${String(col.id).padEnd(14)} ${String(col._productCount).padStart(4)} products  ${col.title.padEnd(44)} (${img})${flag}`,
    );
  }

  // ─── 1B. Aosom product_type hierarchy from Turso ────────────────
  header("1B. AOSOM PRODUCT_TYPE HIERARCHY (Turso live DB)");
  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  const typesRes = await db.execute(
    `SELECT product_type, COUNT(*) as cnt FROM products WHERE product_type IS NOT NULL AND product_type != '' GROUP BY product_type ORDER BY product_type`,
  );
  const productTypeRows = typesRes.rows.map((r) => ({
    type: r.product_type,
    count: Number(r.cnt),
  }));
  const totalTypedProducts = productTypeRows.reduce((s, r) => s + r.count, 0);

  // Also count products with empty product_type
  const emptyRes = await db.execute(
    `SELECT COUNT(*) as cnt FROM products WHERE product_type IS NULL OR product_type = ''`,
  );
  const productsWithNoType = Number(emptyRes.rows[0].cnt);

  // Total products
  const totalRes = await db.execute(`SELECT COUNT(*) as cnt FROM products`);
  const totalProducts = Number(totalRes.rows[0].cnt);

  console.log(`Total products in Turso:        ${totalProducts}`);
  console.log(`With product_type:              ${totalTypedProducts}`);
  console.log(`Without product_type (empty):   ${productsWithNoType}`);
  console.log(`Unique product_type values:     ${productTypeRows.length}`);

  // Build hierarchy tree: level1 → { level2 → count }
  const tree = new Map();
  for (const row of productTypeRows) {
    const parts = (row.type || "").split(" > ");
    const l1 = parts[0] || "(unknown)";
    const l2 = parts.length >= 2 ? parts.slice(1).join(" > ") : null;
    if (!tree.has(l1)) tree.set(l1, { count: 0, level1Direct: 0, children: new Map() });
    const node = tree.get(l1);
    node.count += row.count;
    if (l2) {
      node.children.set(l2, (node.children.get(l2) || 0) + row.count);
    } else {
      node.level1Direct += row.count;
    }
  }

  section("Level-1 → Level-2 tree");
  const l1Sorted = [...tree.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [l1, node] of l1Sorted) {
    console.log(`  [${String(node.count).padStart(4)} total] ${l1}`);
    if (node.level1Direct > 0) {
      console.log(`         ${String(node.level1Direct).padStart(4)} at level-1 only (no subtype)`);
    }
    const l2Sorted = [...node.children.entries()].sort((a, b) => b[1] - a[1]);
    for (const [l2, cnt] of l2Sorted) {
      console.log(`         ${String(cnt).padStart(4)}  > ${l2}`);
    }
  }

  // Cross-reference with existing collection_mappings
  section("Existing collection_mappings in Turso");
  const mappingsRes = await db.execute(
    `SELECT aosom_category, shopify_collection_id, shopify_collection_title FROM collection_mappings ORDER BY aosom_category`,
  );
  const existingMappings = new Map();
  for (const r of mappingsRes.rows) {
    existingMappings.set(r.aosom_category, {
      id: r.shopify_collection_id,
      title: r.shopify_collection_title,
    });
  }
  console.log(`  Existing mappings: ${existingMappings.size}`);
  for (const [cat, m] of existingMappings) {
    console.log(`    "${cat}" → ${m.title} (${m.id})`);
  }

  // ─── 1C. Live Shopify product membership ────────────────────────
  header("1C. SHOPIFY LIVE PRODUCT COLLECTION MEMBERSHIP");
  console.log("Fetching all live Shopify products...");
  const liveProducts = await fetchAllPaginated(
    "/products.json?fields=id,handle,title,status,product_type,tags",
    "products",
  );
  console.log(`  ${liveProducts.length} products\n`);

  console.log("Fetching all collects (custom collection links)...");
  const collects = await fetchAllPaginated("/collects.json", "collects");
  console.log(`  ${collects.length} collects\n`);

  console.log("Fetching smart collection memberships...");
  const smartMembership = new Map(); // product_id → Set<collection_id>
  for (const sc of smart) {
    try {
      const members = await fetchAllPaginated(
        `/collections/${sc.id}/products.json?fields=id`,
        "products",
      );
      for (const p of members) {
        if (!smartMembership.has(p.id)) smartMembership.set(p.id, new Set());
        smartMembership.get(p.id).add(sc.id);
      }
    } catch (e) {
      console.log(`  (smart collection ${sc.id} fetch failed: ${e.message})`);
    }
  }

  // Per-product: collect custom collection IDs from collects + smart memberships
  const productCollections = new Map(); // product_id → Set<collection_id>
  for (const c of collects) {
    if (!productCollections.has(c.product_id)) productCollections.set(c.product_id, new Set());
    productCollections.get(c.product_id).add(c.collection_id);
  }
  for (const [pid, colSet] of smartMembership) {
    if (!productCollections.has(pid)) productCollections.set(pid, new Set());
    for (const cid of colSet) productCollections.get(pid).add(cid);
  }

  // Tally by count
  const buckets = { 0: [], 1: [], 2: [], "3+": [] };
  for (const p of liveProducts) {
    const set = productCollections.get(p.id) || new Set();
    const count = set.size;
    const bucket = count === 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : "3+";
    buckets[bucket].push({ ...p, _collectionIds: [...set], _collectionCount: count });
  }

  section("Products by collection count");
  console.log(`  In 0 collections:  ${buckets[0].length}`);
  console.log(`  In 1 collection:   ${buckets[1].length}`);
  console.log(`  In 2 collections:  ${buckets[2].length}`);
  console.log(`  In 3+ collections: ${buckets["3+"].length}`);

  // Build a collection-title lookup
  const titleById = new Map(allCollections.map((c) => [c.id, c.title]));

  // For "in 1 collection" products, show which collection and whether it's a main or sub
  if (buckets[1].length > 0) {
    section("Products in ONLY 1 collection — breakdown by current collection");
    const grouped = new Map();
    for (const p of buckets[1]) {
      const cid = p._collectionIds[0];
      const title = titleById.get(cid) || `(unknown ${cid})`;
      if (!grouped.has(cid)) grouped.set(cid, { title, products: [], classification: allCollections.find((c) => c.id === cid)?._class?.type || "?" });
      grouped.get(cid).products.push(p);
    }
    const groupedSorted = [...grouped.entries()].sort((a, b) => b[1].products.length - a[1].products.length);
    for (const [cid, info] of groupedSorted) {
      console.log(
        `  [${info.classification.padEnd(4)}] ${String(cid).padEnd(14)} ${String(info.products.length).padStart(4)}  ${info.title}`,
      );
    }
    console.log("\n  Interpretation:");
    console.log("    [main ] rows → products have only their main, need a sub added");
    console.log("    [sub  ] rows → products have only their sub, need a main added");
  }

  // For "in 2 collections" products, check if they are main+sub (healthy) or 2 subs / 2 mains
  if (buckets[2].length > 0) {
    section("Products in 2 collections — is it 1 main + 1 sub?");
    let healthyMainSub = 0;
    let twoMains = 0;
    let twoSubs = 0;
    let unclear = 0;
    for (const p of buckets[2]) {
      const types = p._collectionIds.map((cid) => allCollections.find((c) => c.id === cid)?._class?.type);
      const mainCount = types.filter((t) => t === "main").length;
      const subCount = types.filter((t) => t === "sub").length;
      if (mainCount === 1 && subCount === 1) healthyMainSub++;
      else if (mainCount === 2) twoMains++;
      else if (subCount === 2) twoSubs++;
      else unclear++;
    }
    console.log(`  Healthy (1 main + 1 sub):  ${healthyMainSub}`);
    console.log(`  Both are mains:            ${twoMains}`);
    console.log(`  Both are subs:             ${twoSubs}`);
    console.log(`  Unclear:                   ${unclear}`);
  }

  // ─── Summary: work to do for dual assignment ────────────────────
  header("SUMMARY — WORK TO DO FOR DUAL ASSIGNMENT");

  // Cross-ref: which Level-1 categories have a matching Shopify collection?
  section("Level-1 Aosom categories → Shopify collection match");
  for (const [l1, node] of l1Sorted) {
    // Try fuzzy match against collection titles (case-insensitive, contains or vice-versa)
    const l1Lower = l1.toLowerCase();
    let matches = [];
    for (const col of allCollections) {
      const tLower = col.title.toLowerCase();
      // Try both directions of substring match
      if (tLower.includes(l1Lower) || l1Lower.includes(tLower)) {
        matches.push(col.title);
      }
    }
    // Also try English→French keyword mapping for obvious cases
    const enFr = {
      "patio & garden": "jardin",
      "patio garden": "jardin",
      "home furnishings": "meubles",
      "pet supplies": "animaux",
      "sports": "sport",
      "toys": "jouets",
    };
    for (const [en, fr] of Object.entries(enFr)) {
      if (l1Lower.includes(en)) {
        for (const col of allCollections) {
          if (col.title.toLowerCase().includes(fr) && !matches.includes(col.title)) {
            matches.push(col.title);
          }
        }
      }
    }
    const status = matches.length === 0 ? "✗ NO MATCH" : `→ ${matches.join(", ")}`;
    console.log(`  ${String(node.count).padStart(4)}  ${l1.padEnd(30)} ${status}`);
  }

  section("Level-2 Aosom subcategories → Shopify collection match");
  const allL2 = [];
  for (const [l1, node] of tree) {
    for (const [l2, cnt] of node.children) {
      allL2.push({ l1, l2: `${l1} > ${l2}`, count: cnt });
    }
  }
  allL2.sort((a, b) => b.count - a.count);
  for (const { l2, count } of allL2.slice(0, 30)) {
    const sub = l2.split(" > ").slice(1).join(" > ").toLowerCase();
    const matches = [];
    for (const col of allCollections) {
      if (col.title.toLowerCase().includes(sub) || sub.includes(col.title.toLowerCase())) {
        matches.push(col.title);
      }
    }
    const status = matches.length === 0 ? "✗ NO MATCH" : `→ ${matches.join(", ")}`;
    console.log(`  ${String(count).padStart(4)}  ${l2.slice(0, 50).padEnd(50)} ${status}`);
  }
  if (allL2.length > 30) console.log(`  ... and ${allL2.length - 30} more L2 subcategories not shown`);

  header("FINAL COUNTS");
  console.log(`  Shopify collections:                 ${allCollections.length} (${mains.length} main / ${subs.length} sub proposed)`);
  console.log(`  Empty Shopify collections:           ${allCollections.filter((c) => c._productCount === 0).length}`);
  console.log(`  Aosom Level-1 categories:            ${tree.size}`);
  console.log(`  Aosom Level-2 subcategories:         ${allL2.length}`);
  console.log(`  Products in Turso (total):           ${totalProducts}`);
  console.log(`  Products live on Shopify:            ${liveProducts.length}`);
  console.log(`  Live products in 0 collections:      ${buckets[0].length}`);
  console.log(`  Live products in 1 collection:       ${buckets[1].length}  ← candidates for dual assignment`);
  console.log(`  Live products in 2 collections:      ${buckets[2].length}`);
  console.log(`  Live products in 3+ collections:     ${buckets["3+"].length}`);
  console.log(`  Existing collection_mappings:        ${existingMappings.size}`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. Read-only. Nothing modified.`);
  console.log("Next: review the report, validate the proposed main/sub classification, then decide on Step 2.\n");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
