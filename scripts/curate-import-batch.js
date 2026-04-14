#!/usr/bin/env node
// scripts/curate-import-batch.js
// READ-ONLY curation: picks ~240 products from Turso across 8 categories for
// mass Shopify import. Writes a JSON batch file + markdown report.
// Touches NOTHING in Turso or Shopify. Pure dry-run selection.
//
// Usage: node scripts/curate-import-batch.js
// Env:   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN in .env.local
//
// Output:
//   data/curation/batch-YYYY-MM-DD.json    — machine-readable SKU list
//   data/curation/batch-YYYY-MM-DD.md      — human-readable report

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

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("ERROR: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing in .env.local");
  process.exit(1);
}

// ─── curation spec ───────────────────────────────────────────────────
const PRICE_MIN = 50;
const PRICE_MAX = 800;
const SWEET_SPOT_MIN = 100;
const SWEET_SPOT_MAX = 400;

// Priority order matters for deduplication: a product matching two categories
// lands in the earlier one in this list.
const CATEGORIES = [
  {
    key: "salon",
    label: "Salon / Séjour",
    count: 30,
    patterns: ["Living Room Furniture"],
  },
  {
    key: "cuisine",
    label: "Cuisine / Salle à manger",
    count: 30,
    patterns: ["Kitchen & Dining Furniture"],
  },
  {
    key: "chiens",
    label: "Animaux — Chiens",
    count: 30,
    patterns: ["Pet Supplies > Dogs"],
  },
  {
    key: "chats",
    label: "Animaux — Chats",
    count: 30,
    patterns: ["Pet Supplies > Cats"],
  },
  {
    key: "enfants",
    label: "Enfants (Toys & Games)",
    count: 30,
    patterns: ["Toys & Games"],
  },
  {
    key: "bureau",
    label: "Bureau",
    count: 30,
    patterns: ["Office Furniture"],
  },
  {
    key: "patio",
    label: "Patio & Jardin (meubles extérieurs)",
    count: 30,
    patterns: ["Patio Furniture", "Patio Shade", "Patio Swings", "Sun Loungers"],
  },
  {
    key: "chambre",
    label: "Chambre à coucher",
    count: 30,
    patterns: ["Bedroom Furniture"],
  },
];

// ─── variant grouping (mirrors src/lib/variant-merger.ts COLOR_MAP + parseSku) ──
// Products table has no psin column, so we use the same 2-char color suffix
// heuristic that the existing import pipeline uses for fallback grouping.
const COLOR_MAP = new Set([
  "BK","CG","DR","GN","LG","YG","SR","CW","TK","GY","BU","BN","BG",
  "DB","GG","KK","WN","WT","RD","PK","OG","NT","CF",
]);

function parseBaseSku(sku) {
  if (!sku || sku.length <= 4) return sku;
  const suffix = sku.slice(-2);
  return COLOR_MAP.has(suffix) ? sku.slice(0, -2) : sku;
}

// ─── helpers ─────────────────────────────────────────────────────────
function countImages(p) {
  let n = 0;
  for (const k of ["image1", "image2", "image3", "image4", "image5", "image6", "image7"]) {
    if (typeof p[k] === "string" && p[k].trim().length > 0) n++;
  }
  return n;
}

function scoreProduct(p) {
  const images = countImages(p);
  let score = 0;
  // Up to +18 for 7 images (6 extras × 3)
  score += Math.max(0, (images - 1) * 3);
  // Sweet-spot bonus: Quebec buyers bite hardest between 100$ and 400$
  if (p.price >= SWEET_SPOT_MIN && p.price <= SWEET_SPOT_MAX) score += 5;
  // Clear name: short enough to read in a grid tile
  if (typeof p.name === "string" && p.name.length > 0 && p.name.length <= 60) score += 2;
  // Has a description Claude can rewrite for SEO
  if (typeof p.description === "string" && p.description.length > 50) score += 1;
  return { score, imageCount: images };
}

function matchesCategory(productType, patterns) {
  if (!productType) return false;
  for (const pat of patterns) {
    if (productType.includes(pat)) return true;
  }
  return false;
}

function fmtPrice(n) {
  return `${Number(n).toFixed(2)}$`;
}

// ─── main ────────────────────────────────────────────────────────────
(async () => {
  console.log("[curate] Loading importable pool from Turso...");

  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  // Pool: in-stock, in-price-band, not yet on Shopify, has at least 1 image
  const result = await db.execute({
    sql: `SELECT sku, name, price, qty, product_type, description,
                 image1, image2, image3, image4, image5, image6, image7
          FROM products
          WHERE qty > 0
            AND price >= ?
            AND price <= ?
            AND (shopify_product_id IS NULL OR shopify_product_id = '')
            AND image1 IS NOT NULL
            AND image1 != ''`,
    args: [PRICE_MIN, PRICE_MAX],
  });

  const pool = result.rows;
  console.log(`[curate] Pool: ${pool.length} candidates`);

  // ─── categorize with priority-based dedup + variant grouping ─────
  // Dedup happens on two axes:
  //   1. Inter-category: a SKU assigned to an earlier category can't be taken by a later one
  //   2. Intra-category: variants of the same product (same base SKU) collapse into
  //      one "listing" represented by the highest-scoring variant, with siblings tracked.
  //      This mirrors how src/lib/variant-merger.ts groups the CSV feed via parseSku().
  const assignedBases = new Set(); // base SKU → locked after first category claims it
  const perCat = {};

  for (const cat of CATEGORIES) {
    perCat[cat.key] = {
      label: cat.label,
      target: cat.count,
      candidates: [],
      selected: [],
      variantsCollapsed: 0,
    };
    // First pass: score every raw matching row
    const rawMatches = [];
    for (const p of pool) {
      if (!matchesCategory(p.product_type, cat.patterns)) continue;
      const base = parseBaseSku(p.sku);
      if (assignedBases.has(base)) continue;
      const { score, imageCount } = scoreProduct(p);
      rawMatches.push({
        sku: p.sku,
        base,
        name: p.name,
        price: Number(p.price),
        qty: Number(p.qty),
        product_type: p.product_type,
        image_count: imageCount,
        score,
      });
    }
    // Group by base SKU, keep the highest-scoring variant as the listing representative.
    // Tie-breaker: more images wins, then alphabetical SKU for determinism.
    const byBase = new Map();
    for (const m of rawMatches) {
      const existing = byBase.get(m.base);
      if (!existing) {
        byBase.set(m.base, { ...m, variant_count: 1, variant_skus: [m.sku] });
        continue;
      }
      existing.variant_count++;
      existing.variant_skus.push(m.sku);
      const better =
        m.score > existing.score ||
        (m.score === existing.score && m.image_count > existing.image_count) ||
        (m.score === existing.score && m.image_count === existing.image_count && m.sku < existing.sku);
      if (better) {
        // Promote the better variant as representative; keep tracking metadata
        const vc = existing.variant_count;
        const vs = existing.variant_skus;
        byBase.set(m.base, { ...m, variant_count: vc, variant_skus: vs });
      }
    }
    const listings = Array.from(byBase.values());
    listings.sort((a, b) =>
      b.score - a.score ||
      b.image_count - a.image_count ||
      b.variant_count - a.variant_count
    );
    perCat[cat.key].candidates = listings;
    perCat[cat.key].variantsCollapsed = rawMatches.length - listings.length;
    perCat[cat.key].selected = listings.slice(0, cat.count);
    // Lock the chosen base SKUs so later categories can't re-claim any variant
    for (const s of perCat[cat.key].selected) assignedBases.add(s.base);
  }

  // ─── summary ──────────────────────────────────────────────────────
  const totalSelected = Object.values(perCat).reduce((a, c) => a + c.selected.length, 0);
  const totalCandidates = Object.values(perCat).reduce((a, c) => a + c.candidates.length, 0);
  console.log(`[curate] Selected ${totalSelected} products (from ${totalCandidates} category matches)`);

  // ─── outputs ──────────────────────────────────────────────────────
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(__dirname, "..", "data", "curation");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `batch-${date}.json`);
  const mdPath = path.join(outDir, `batch-${date}.md`);

  // JSON: flat list of SKUs with category tag, ready for a future import step
  const jsonOut = {
    generated_at: new Date().toISOString(),
    pool_size: pool.length,
    price_band: [PRICE_MIN, PRICE_MAX],
    total_selected: totalSelected,
    categories: CATEGORIES.map((c) => ({
      key: c.key,
      label: c.label,
      target: c.count,
      selected_count: perCat[c.key].selected.length,
      candidate_count: perCat[c.key].candidates.length,
      skus: perCat[c.key].selected.map((s) => s.sku),
    })),
    products: Object.entries(perCat).flatMap(([catKey, data]) =>
      data.selected.map((p) => ({
        category: catKey,
        sku: p.sku,
        base_sku: p.base,
        name: p.name,
        price: p.price,
        qty: p.qty,
        product_type: p.product_type,
        image_count: p.image_count,
        score: p.score,
        variant_count: p.variant_count,
        variant_skus: p.variant_skus,
      }))
    ),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));

  // Markdown: human-readable report per category
  const md = [];
  md.push(`# Curation Batch — ${date}`);
  md.push("");
  md.push(`**Pool:** ${pool.length} candidates (qty>0, ${fmtPrice(PRICE_MIN)}–${fmtPrice(PRICE_MAX)}, not on Shopify, ≥1 image)  `);
  md.push(`**Selected:** ${totalSelected} / ${CATEGORIES.reduce((a, c) => a + c.count, 0)} target  `);
  md.push(`**Dedup:** priority by category order (Salon > Cuisine > Chiens > Chats > Enfants > Bureau > Patio > Chambre)  `);
  md.push(`**Scoring:** +3/image beyond 1st (max +18), +5 if price in [${fmtPrice(SWEET_SPOT_MIN)}–${fmtPrice(SWEET_SPOT_MAX)}], +2 if name ≤60 chars, +1 if description >50 chars`);
  md.push("");
  md.push("---");
  md.push("");

  for (const cat of CATEGORIES) {
    const data = perCat[cat.key];
    const selected = data.selected;
    if (selected.length === 0) {
      md.push(`## ${cat.label}`);
      md.push(`**⚠ 0 selected / ${data.candidates.length} candidates — check patterns.**`);
      md.push("");
      continue;
    }
    const prices = selected.map((s) => s.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const avgP = prices.reduce((a, b) => a + b, 0) / prices.length;
    const avgImg = selected.reduce((a, s) => a + s.image_count, 0) / selected.length;
    const avgScore = selected.reduce((a, s) => a + s.score, 0) / selected.length;

    const totalVariants = selected.reduce((a, s) => a + s.variant_count, 0);

    md.push(`## ${cat.label}`);
    md.push(`**${selected.length} listings selected** / ${data.candidates.length} unique listings · ${data.variantsCollapsed} variants collapsed · target ${cat.count}`);
    md.push("");
    md.push(`- Price range: ${fmtPrice(minP)} – ${fmtPrice(maxP)} (avg ${fmtPrice(avgP)})`);
    md.push(`- Avg images: ${avgImg.toFixed(1)} / 7`);
    md.push(`- Avg score: ${avgScore.toFixed(1)}`);
    md.push(`- Variants bundled: ${totalVariants} SKUs grouped into ${selected.length} listings`);
    md.push("");
    md.push("### Top 10 by score");
    md.push("");
    md.push("| # | SKU (rep.) | Name | Price | Photos | Variants | Score |");
    md.push("|---|---|---|---|---|---|---|");
    selected.slice(0, 10).forEach((p, i) => {
      const safeName = (p.name || "").replace(/\|/g, "\\|").slice(0, 60);
      md.push(`| ${i + 1} | \`${p.sku}\` | ${safeName} | ${fmtPrice(p.price)} | ${p.image_count} | ${p.variant_count} | ${p.score} |`);
    });
    md.push("");
    if (selected.length > 10) {
      md.push(`<details><summary>All ${selected.length} selected listings</summary>`);
      md.push("");
      md.push("| # | SKU (rep.) | Name | Price | Photos | Variants | Score |");
      md.push("|---|---|---|---|---|---|---|");
      selected.forEach((p, i) => {
        const safeName = (p.name || "").replace(/\|/g, "\\|").slice(0, 60);
        md.push(`| ${i + 1} | \`${p.sku}\` | ${safeName} | ${fmtPrice(p.price)} | ${p.image_count} | ${p.variant_count} | ${p.score} |`);
      });
      md.push("");
      md.push("</details>");
      md.push("");
    }
    md.push("---");
    md.push("");
  }

  fs.writeFileSync(mdPath, md.join("\n"));

  console.log(`[curate] Wrote JSON: ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`[curate] Wrote MD:   ${path.relative(process.cwd(), mdPath)}`);

  // ─── console summary ──────────────────────────────────────────────
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("CURATION SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  for (const cat of CATEGORIES) {
    const data = perCat[cat.key];
    const n = data.selected.length;
    const target = cat.count;
    const marker = n === target ? "✓" : n === 0 ? "✗" : "⚠";
    const pad = (cat.label + " ".repeat(40)).slice(0, 40);
    console.log(`  ${marker} ${pad} ${n}/${target}  (${data.candidates.length} candidates)`);
  }
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  TOTAL                                    ${totalSelected}/${CATEGORIES.reduce((a, c) => a + c.count, 0)}`);
  console.log("═══════════════════════════════════════════════════════════════");

  process.exit(0);
})().catch((err) => {
  console.error("[curate] ERROR:", err);
  process.exit(1);
});
