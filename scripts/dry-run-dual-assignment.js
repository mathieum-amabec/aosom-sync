#!/usr/bin/env node
// scripts/dry-run-dual-assignment.js
// Dry-run migration for the 51 products that are currently in only 1 collection.
// Determines the missing 2nd collection (main or sub) for each and prints the plan.
// Writes NOTHING. Pure analysis + report.
//
// Strategy for each "in 1 collection" product:
//   1. Get its current collection and classify it (main or sub) using the migrated
//      collection_mappings table as the source of truth.
//   2. Look up what the MISSING counterpart should be, preferring:
//      - The product's stored product_type from Turso (most specific)
//      - Fallback: the parent L1 category of the current sub-collection's mapping key
//   3. Output a proposal: "product X currently in [sub] Y, would add [main] Z"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--execute");

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

const STORE = (process.env.SHOPIFY_STORE_URL || "27u5y2-kp.myshopify.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const API = "2024-01";

// ─── Shopify helper ──────────────────────────────────────────────────
async function sget(ep) {
  const r = await fetch(`https://${STORE}/admin/api/${API}${ep}`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN },
  });
  if (r.status === 429) {
    await new Promise((x) => setTimeout(x, 2000));
    return sget(ep);
  }
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const link = r.headers.get("link") || "";
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  const next = m ? new URL(m[1]).searchParams.get("page_info") : null;
  return { body: await r.json(), next };
}

async function sall(ep, key) {
  const out = [];
  let pi = null;
  const sep = ep.includes("?") ? "&" : "?";
  do {
    const url = pi ? `${ep}${sep}page_info=${pi}&limit=250` : `${ep}${sep}limit=250`;
    const { body, next } = await sget(url);
    if (Array.isArray(body[key])) out.push(...body[key]);
    pi = next;
  } while (pi);
  return out;
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nDry-run dual collection assignment — 51 products\n`);
  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  // 1. Load all mappings from Turso (post-migration schema)
  const mappingRows = (
    await db.execute(
      "SELECT aosom_category, collection_role, shopify_collection_id, shopify_collection_title FROM collection_mappings",
    )
  ).rows;

  // Index by collection_id → list of mappings (aosom keys pointing to this collection)
  const collectionToAosomKeys = new Map(); // shopify_id → [{ aosom, role }]
  // Index by aosom_category → { main: ..., sub: ... }
  const aosomToRoles = new Map(); // aosom_category → { main?, sub? }

  for (const row of mappingRows) {
    const cid = String(row.shopify_collection_id); // normalize: Shopify API returns numbers, Turso stores strings
    const aosom = row.aosom_category;
    const role = row.collection_role;
    if (!collectionToAosomKeys.has(cid)) collectionToAosomKeys.set(cid, []);
    collectionToAosomKeys.get(cid).push({ aosom, role });
    if (!aosomToRoles.has(aosom)) aosomToRoles.set(aosom, {});
    aosomToRoles.get(aosom)[role] = { collectionId: cid, title: row.shopify_collection_title };
  }

  console.log(`Loaded ${mappingRows.length} mapping rows from Turso (post-migration)`);
  const mainCollections = new Set();
  const subCollections = new Set();
  for (const [cid, list] of collectionToAosomKeys) {
    const hasMainUse = list.some((x) => x.role === "main");
    const hasSubUse = list.some((x) => x.role === "sub");
    if (hasMainUse) mainCollections.add(cid);
    if (hasSubUse) subCollections.add(cid);
  }
  console.log(`  Collections used as 'main': ${mainCollections.size}`);
  console.log(`  Collections used as 'sub':  ${subCollections.size}\n`);

  // 2. Load Turso products table (map Shopify product_id → product_type)
  const tursoProductsRes = await db.execute(
    "SELECT shopify_product_id, product_type, name FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''",
  );
  const shopifyIdToTurso = new Map();
  for (const r of tursoProductsRes.rows) {
    shopifyIdToTurso.set(String(r.shopify_product_id), { productType: r.product_type, name: r.name });
  }
  console.log(`Turso products with shopify_product_id: ${shopifyIdToTurso.size}\n`);

  // 3. Fetch live Shopify products + collects + smart memberships
  console.log("Fetching Shopify state...");
  const [products, collects, custom, smart] = await Promise.all([
    sall("/products.json?fields=id,title,status,product_type", "products"),
    sall("/collects.json", "collects"),
    sall("/custom_collections.json", "custom_collections"),
    sall("/smart_collections.json", "smart_collections"),
  ]);
  const titleById = new Map([...custom, ...smart].map((c) => [c.id, c.title]));
  const pc = new Map();
  for (const c of collects) {
    if (!pc.has(c.product_id)) pc.set(c.product_id, new Set());
    pc.get(c.product_id).add(c.collection_id);
  }
  for (const sc of smart) {
    const members = await sall(`/collections/${sc.id}/products.json?fields=id`, "products");
    for (const p of members) {
      if (!pc.has(p.id)) pc.set(p.id, new Set());
      pc.get(p.id).add(sc.id);
    }
  }
  console.log(`  ${products.length} products, ${collects.length} collects\n`);

  // 4. Isolate the 51 products in exactly 1 collection
  const oneCol = products.filter((p) => (pc.get(p.id) || new Set()).size === 1);
  console.log(`Products in exactly 1 collection: ${oneCol.length}\n`);

  // 5. For each, determine the missing main or sub
  function classifyCollectionId(cid) {
    const key = String(cid);
    const isMain = mainCollections.has(key);
    const isSub = subCollections.has(key);
    if (isMain && isSub) return "main_or_sub"; // ambiguous
    if (isMain) return "main";
    if (isSub) return "sub";
    return "unknown";
  }

  // Build a "reverse" lookup: given a collection_id used as sub, find its parent L1 (Patio & Garden, etc)
  // by looking at the aosom_category keys that point to it and extracting the L1 prefix
  function findParentL1ForSubCollection(cid) {
    const keys = collectionToAosomKeys.get(String(cid)) || [];
    for (const { aosom, role } of keys) {
      if (role !== "sub") continue;
      const l1 = aosom.split(" > ")[0];
      if (l1) return l1;
    }
    return null;
  }

  // Walk the aosom hierarchy to find a mapping of the given role
  function findMappingForProductType(productType, role) {
    if (!productType) return null;
    const parts = productType.split(">").map((s) => s.trim()).filter(Boolean);
    for (let i = parts.length; i >= 1; i--) {
      const key = parts.slice(0, i).join(" > ");
      const roles = aosomToRoles.get(key);
      if (roles && roles[role]) return { aosomKey: key, ...roles[role] };
    }
    return null;
  }

  const proposals = [];
  const cantDecide = [];

  for (const p of oneCol) {
    const cidRaw = [...pc.get(p.id)][0];
    const cid = String(cidRaw);
    const currentCol = titleById.get(cidRaw) || titleById.get(cid) || `(unknown ${cid})`;
    const currentRole = classifyCollectionId(cid);
    const tursoData = shopifyIdToTurso.get(String(p.id));
    const productType = tursoData?.productType || p.product_type || null;

    let proposal = null;

    // Case 1: currently in a 'sub', need to add a 'main'
    if (currentRole === "sub") {
      // Try lookup by productType
      if (productType) {
        const main = findMappingForProductType(productType, "main");
        if (main) {
          proposal = { type: "add_main", via: `productType "${productType}"`, target: main };
        }
      }
      // Fallback: infer L1 from the sub collection's mapping key
      if (!proposal) {
        const parentL1 = findParentL1ForSubCollection(cid);
        if (parentL1) {
          const roles = aosomToRoles.get(parentL1);
          if (roles?.main) {
            proposal = { type: "add_main", via: `sub→L1 "${parentL1}"`, target: roles.main };
          }
        }
      }
    }
    // Case 2: currently in a 'main', need to add a 'sub'
    else if (currentRole === "main") {
      if (productType) {
        const sub = findMappingForProductType(productType, "sub");
        if (sub) {
          proposal = { type: "add_sub", via: `productType "${productType}"`, target: sub };
        }
      }
    }
    // Case 3: ambiguous or unknown current collection
    else {
      // Try both lookups from productType
      if (productType) {
        const main = findMappingForProductType(productType, "main");
        const sub = findMappingForProductType(productType, "sub");
        if (main && main.collectionId !== cid) proposal = { type: "add_main", via: `productType "${productType}"`, target: main };
        else if (sub && sub.collectionId !== cid) proposal = { type: "add_sub", via: `productType "${productType}"`, target: sub };
      }
    }

    if (proposal) {
      proposals.push({
        id: p.id,
        title: p.title,
        current: { id: cid, title: currentCol, role: currentRole },
        productType,
        proposal,
      });
    } else {
      cantDecide.push({
        id: p.id,
        title: p.title,
        current: { id: cid, title: currentCol, role: currentRole },
        productType,
      });
    }
  }

  // 6. Group proposals by (current + target) pattern for summary
  console.log("=".repeat(80));
  console.log("  PROPOSED ADDITIONS (grouped by pattern)");
  console.log("=".repeat(80));
  const grouped = new Map();
  for (const p of proposals) {
    const key = `${p.current.title} [${p.current.role}] → add ${p.proposal.target.title} [${p.proposal.type === "add_main" ? "main" : "sub"}]`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }
  const groupedSorted = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [pattern, items] of groupedSorted) {
    console.log(`\n  [${items.length} products]  ${pattern}`);
    for (const p of items.slice(0, 3)) {
      console.log(`      - ${(p.title || "").slice(0, 65)}`);
    }
    if (items.length > 3) console.log(`      ... and ${items.length - 3} more`);
  }

  if (cantDecide.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log(`  CANNOT DECIDE (${cantDecide.length} products — no match in mapping table)`);
    console.log("=".repeat(80));
    for (const p of cantDecide) {
      console.log(`  ${String(p.id).padEnd(14)} in [${p.current.role}] ${p.current.title}`);
      console.log(`                 title: ${(p.title || "").slice(0, 60)}`);
      console.log(`                 product_type: ${p.productType || "(null)"}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("  SUMMARY");
  console.log("=".repeat(80));
  console.log(`  Total products in 1 collection:    ${oneCol.length}`);
  console.log(`  Auto-resolved (will add a main):   ${proposals.filter((p) => p.proposal.type === "add_main").length}`);
  console.log(`  Auto-resolved (will add a sub):    ${proposals.filter((p) => p.proposal.type === "add_sub").length}`);
  console.log(`  Cannot decide (need manual):       ${cantDecide.length}`);
  console.log(`\n  Total POST /collects.json calls if approved: ${proposals.length}`);
  console.log(`  Estimated duration at 500ms/call:            ~${(proposals.length * 0.5).toFixed(0)}s\n`);

  if (!EXECUTE) {
    console.log("\x1b[32mDRY RUN — no changes made.\x1b[0m");
    console.log("To apply, run: node scripts/dry-run-dual-assignment.js --execute\n");
    return;
  }

  // ─── EXECUTE ───────────────────────────────────────────────────
  console.log(`\x1b[31mEXECUTING — adding ${proposals.length} collection links...\x1b[0m\n`);
  let success = 0;
  let alreadyLinked = 0;
  let failures = 0;
  const errors = [];

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const body = {
      collect: {
        product_id: p.id,
        collection_id: Number(p.proposal.target.collectionId),
      },
    };
    try {
      const res = await fetch(`https://${STORE}/admin/api/${API}/collects.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        // respect retry-after
        const ra = parseFloat(res.headers.get("Retry-After") || "2");
        await new Promise((r) => setTimeout(r, ra * 1000));
        i--; // retry
        continue;
      }
      if (res.status === 422) {
        // Shopify returns 422 when the collect already exists — treat as idempotent skip.
        const text = await res.text();
        if (/already exists|has already been taken/i.test(text)) {
          alreadyLinked++;
          const pct = (((i + 1) / proposals.length) * 100).toFixed(0);
          process.stdout.write(`  [${pct}%] ${success} added, ${alreadyLinked} already linked, ${failures} errors\r`);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw new Error(`422: ${text}`);
      }
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      success++;
      const pct = (((i + 1) / proposals.length) * 100).toFixed(0);
      process.stdout.write(`  [${pct}%] ${success} added, ${alreadyLinked} already linked, ${failures} errors\r`);
    } catch (e) {
      failures++;
      errors.push({ id: p.id, title: p.title, error: e.message });
    }
    // Rate limit: 500ms between calls (2 req/sec bucket)
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n\nDone. Added: ${success}, Already linked: ${alreadyLinked}, Errors: ${failures}`);
  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const e of errors) console.log(`  ${e.id} (${(e.title || "").slice(0, 50)}): ${e.error}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});
