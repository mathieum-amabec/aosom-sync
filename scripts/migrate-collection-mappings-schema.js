#!/usr/bin/env node
// scripts/migrate-collection-mappings-schema.js
// Migrate collection_mappings table to support dual (main + sub) assignment.
//
// Schema change (C2):
//   OLD: PRIMARY KEY (aosom_category) — one collection per category
//   NEW: PRIMARY KEY (aosom_category, collection_role)
//        collection_role IN ('main', 'sub')
//
// Idempotent: if already migrated, skip.
//
// Also seeds the A1a super-main rows:
//   "Patio & Garden"      → "Mobiliers extérieurs et jardins" (main)
//   "Home Furnishings"    → "Meubles et décorations"           (main)
//   "Pet Supplies"        → "Accessoires pour animaux"         (main)
//   "Toys & Games"        → "Jouets pour enfants"              (main)  [already main, promote existing]
//   "Office Products"     → "Bureau"                           (main)  [already main, promote existing]
//   "Sports & Recreation" → "Sports et loisirs"                (main)  [already main, promote existing]
//   "Home Improvement"    → "Autres"                           (main)  [already main, promote existing]
//   "Health & Beauty"     → "Autres"                           (main)  [already main, promote existing]
//
// Usage:
//   node scripts/migrate-collection-mappings-schema.js           # dry-run
//   node scripts/migrate-collection-mappings-schema.js --execute # actually migrate

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

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("ERROR: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}

// A1a super-mains (Mathieu's decision)
const SUPER_MAINS = [
  { aosom: "Patio & Garden", collectionId: "312997642345", title: "Mobiliers extérieurs et jardins" },
  { aosom: "Home Furnishings", collectionId: "312997281897", title: "Meubles et décorations" },
  { aosom: "Pet Supplies", collectionId: "312998068329", title: "Accessoires pour animaux" },
  { aosom: "Toys & Games", collectionId: "312997871721", title: "Jouets pour enfants" },
  { aosom: "Office Products", collectionId: "312997511273", title: "Bureau" },
  { aosom: "Sports & Recreation", collectionId: "312997937257", title: "Sports et loisirs" },
  { aosom: "Home Improvement", collectionId: "312998199401", title: "Autres" },
  { aosom: "Health & Beauty", collectionId: "312998199401", title: "Autres" },
];

async function main() {
  console.log(`\nCollection mappings schema migration — ${EXECUTE ? "\x1b[31mEXECUTE\x1b[0m" : "\x1b[32mDRY RUN\x1b[0m"}`);
  console.log(`Turso: ${TURSO_URL}\n`);

  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  // Check current schema via PRAGMA
  const pragma = await db.execute("PRAGMA table_info(collection_mappings)");
  const columns = pragma.rows.map((r) => r.name);
  console.log(`Current columns: ${columns.join(", ")}`);
  const hasRole = columns.includes("collection_role");

  if (hasRole) {
    console.log("\n✓ Schema already has collection_role. Nothing to migrate.");
    // Check super-mains coverage
    const rows = (
      await db.execute("SELECT aosom_category, collection_role, shopify_collection_title FROM collection_mappings WHERE collection_role = 'main'")
    ).rows;
    console.log(`\nExisting 'main' rows: ${rows.length}`);
    for (const r of rows) console.log(`  ${r.aosom_category.padEnd(25)} → ${r.shopify_collection_title}`);
    return;
  }

  console.log("\nSchema needs migration. Reading existing data...");
  const existing = (
    await db.execute("SELECT aosom_category, shopify_collection_id, shopify_collection_title, updated_at FROM collection_mappings")
  ).rows.map((r) => ({
    aosomCategory: r.aosom_category,
    shopifyCollectionId: r.shopify_collection_id,
    shopifyCollectionTitle: r.shopify_collection_title,
    updatedAt: r.updated_at,
  }));
  console.log(`Existing rows: ${existing.length}`);

  // Infer role for each existing row
  // Rule: aosom_category contains " > " → 'sub', else → 'main'
  const withRoles = existing.map((m) => ({
    ...m,
    role: m.aosomCategory.includes(" > ") ? "sub" : "main",
  }));
  const mainsInExisting = withRoles.filter((m) => m.role === "main");
  const subsInExisting = withRoles.filter((m) => m.role === "sub");
  console.log(`  Inferred 'main' (no " > "):  ${mainsInExisting.length}`);
  console.log(`  Inferred 'sub' (has " > "):  ${subsInExisting.length}`);

  // Compute super-main rows to add (skip if already present with same category+role)
  const existingMainKeys = new Set(mainsInExisting.map((m) => m.aosomCategory));
  const superMainRowsToAdd = SUPER_MAINS.filter((sm) => !existingMainKeys.has(sm.aosom));

  console.log(`\nA1a super-main rows to seed:`);
  for (const sm of SUPER_MAINS) {
    const already = existingMainKeys.has(sm.aosom);
    const marker = already ? "(already present)" : "NEW";
    console.log(`  [${marker.padEnd(18)}] ${sm.aosom.padEnd(22)} → ${sm.title}`);
  }

  // Plan summary
  const newTotal = existing.length + superMainRowsToAdd.length;
  console.log(`\nPlan:`);
  console.log(`  1. CREATE collection_mappings_new with composite PK (aosom_category, collection_role)`);
  console.log(`  2. INSERT ${existing.length} existing rows with inferred role`);
  console.log(`  3. INSERT ${superMainRowsToAdd.length} new A1a super-main rows`);
  console.log(`  4. DROP collection_mappings`);
  console.log(`  5. RENAME collection_mappings_new → collection_mappings`);
  console.log(`  → Final row count: ${newTotal}`);

  if (!EXECUTE) {
    console.log("\n\x1b[32mDRY RUN — no changes made.\x1b[0m");
    console.log("To apply, run: node scripts/migrate-collection-mappings-schema.js --execute\n");
    return;
  }

  // Execute
  console.log("\n\x1b[31mEXECUTING...\x1b[0m");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS collection_mappings_new (
      aosom_category TEXT NOT NULL,
      collection_role TEXT NOT NULL CHECK(collection_role IN ('main', 'sub')),
      shopify_collection_id TEXT NOT NULL,
      shopify_collection_title TEXT NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (aosom_category, collection_role)
    )
  `);
  console.log("  ✓ Created collection_mappings_new");

  // Insert existing rows
  for (const m of withRoles) {
    await db.execute({
      sql: `INSERT OR REPLACE INTO collection_mappings_new (aosom_category, collection_role, shopify_collection_id, shopify_collection_title, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [m.aosomCategory, m.role, m.shopifyCollectionId, m.shopifyCollectionTitle, m.updatedAt || Math.floor(Date.now() / 1000)],
    });
  }
  console.log(`  ✓ Inserted ${withRoles.length} existing rows`);

  // Insert super-mains (only new ones, idempotent via composite PK)
  let added = 0;
  for (const sm of SUPER_MAINS) {
    const result = await db.execute({
      sql: `INSERT OR IGNORE INTO collection_mappings_new (aosom_category, collection_role, shopify_collection_id, shopify_collection_title, updated_at)
            VALUES (?, 'main', ?, ?, strftime('%s','now'))`,
      args: [sm.aosom, sm.collectionId, sm.title],
    });
    if (result.rowsAffected > 0) added++;
  }
  console.log(`  ✓ Inserted ${added} new super-main rows`);

  await db.execute("DROP TABLE collection_mappings");
  await db.execute("ALTER TABLE collection_mappings_new RENAME TO collection_mappings");
  console.log("  ✓ Swapped tables");

  // Verify
  const finalRows = (await db.execute("SELECT COUNT(*) as cnt FROM collection_mappings")).rows[0];
  const finalMains = (await db.execute("SELECT COUNT(*) as cnt FROM collection_mappings WHERE collection_role = 'main'")).rows[0];
  const finalSubs = (await db.execute("SELECT COUNT(*) as cnt FROM collection_mappings WHERE collection_role = 'sub'")).rows[0];
  console.log(`\n✓ Migration complete.`);
  console.log(`  Total rows:  ${finalRows.cnt}`);
  console.log(`  'main' rows: ${finalMains.cnt}`);
  console.log(`  'sub' rows:  ${finalSubs.cnt}\n`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});
