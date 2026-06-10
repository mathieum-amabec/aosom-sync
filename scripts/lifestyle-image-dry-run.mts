// Phase 2 — DRY-RUN for the lifestyle/white-background featured-image heuristic.
//
// For each of the 30 top-seller SKUs (docs/audit-pdp-video.md), compares the
// CURRENT featured image (sync selectProductImages, position 0) with the one the
// new white-background heuristic would promote (classifyProductImages + the same
// ordering selectProductImagesAsync uses). READ-ONLY — no Shopify/DB writes.
//
// Run (x64 node, env from .env.local):
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/lifestyle-image-dry-run.ts
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  selectProductImages,
  classifyProductImages,
  smallestUrlDimension,
  MIN_IMAGE_PX,
  type ImageKind,
} from "../src/lib/variant-merger";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Top 30 by inferred stock velocity — docs/audit-pdp-video.md §6.
const SKUS = [
  "84A-009BK", "84A-054V05BK", "845-792V00YL", "84K-241V00LG", "845-039V01GY",
  "845-652V00GY", "01-0893", "845-518GY", "84H-209V00CG", "845-774V00BK",
  "84G-791V00BK", "84A-009", "84C-142V01CG", "84A-009BN", "845-335",
  "84B-136BK", "844-610V00BK", "823-010V81", "84B-136", "370-198BK",
  "823-002V80", "84K-241V00CG", "867-034", "845-774V00SR", "84C-226CG",
  "84A-054V05BN", "D51-277V01", "84B-146BU", "824-024V80BK", "01-0902",
];

// Same priority bands as selectProductImagesAsync (lifestyle → CSV order → white).
const RANK: Record<ImageKind, number> = { lifestyle_url: 0, lifestyle_bg: 0, unknown: 1, white_bg: 2 };
const classifLabel = (k: ImageKind) =>
  k.startsWith("lifestyle") ? "lifestyle" : k === "white_bg" ? "fond_blanc" : "inconnu";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("TURSO_DATABASE_URL missing (run with --env-file=.env.local)");
const db = createClient({ url, authToken });

interface Row {
  sku: string; name: string;
  current0: string; classifCurrent: string;
  proposed0: string; classifProposed: string;
  changed: boolean;
}
const rows: Row[] = [];
let changedCount = 0;
let analysed = 0;

console.log(`DRY-RUN lifestyle featured image — ${SKUS.length} SKUs (read-only)\n`);

for (const sku of SKUS) {
  const res = await db.execute({
    sql: `SELECT sku, name, image1, image2, image3, image4, image5, image6, image7
          FROM products WHERE sku = ? LIMIT 1`,
    args: [sku],
  });
  if (!res.rows.length) {
    rows.push({ sku, name: "(introuvable en DB)", current0: "", classifCurrent: "inconnu", proposed0: "", classifProposed: "inconnu", changed: false });
    console.log(`  miss ${sku} — not in products table`);
    continue;
  }
  const o = res.rows[0] as unknown as Record<string, string | null>;
  const images = [o.image1, o.image2, o.image3, o.image4, o.image5, o.image6, o.image7]
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  const current0 = selectProductImages(images)[0] ?? "";

  // Apply the same sub-800px filter, then classify (network + sharp).
  const filtered = images.filter((u) => {
    const d = smallestUrlDimension(u);
    return d === null || d >= MIN_IMAGE_PX;
  });
  const kinds = await classifyProductImages(filtered);
  const ordered = kinds
    .map((c, i) => ({ c, i }))
    .sort((a, b) => RANK[a.c.kind] - RANK[b.c.kind] || a.i - b.i)
    .map((x) => x.c.url);
  const proposed0 = ordered[0] ?? "";
  const kindOf = (u: string) => kinds.find((k) => k.url === u)?.kind ?? "unknown";
  const classifCurrent = classifLabel(kindOf(current0));
  const classifProposed = classifLabel(kindOf(proposed0));
  const changed = current0 !== "" && proposed0 !== "" && current0 !== proposed0;
  if (changed) changedCount++;
  analysed++;

  rows.push({ sku, name: String(o.name ?? ""), current0, classifCurrent, proposed0, classifProposed, changed });
  console.log(`${changed ? "CHANGE" : "  keep"} ${sku.padEnd(14)} ${classifCurrent} -> ${classifProposed}${changed ? `\n     avant: ${current0}\n     après: ${proposed0}` : ""}`);
}

// ---- CSV (UTF-8 BOM) ----
const headers = ["sku", "name", "image_actuelle_pos0", "classif_actuelle", "image_proposee_pos0", "classif_proposee", "changement"];
const esc = (v: string) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const lines = [headers.join(",")];
for (const r of rows) {
  lines.push([r.sku, r.name, r.current0, r.classifCurrent, r.proposed0, r.classifProposed, r.changed ? "oui" : "non"].map((v) => esc(String(v))).join(","));
}
const outDir = join(__dirname, "..", "docs");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "lifestyle-image-dry-run.csv"), "﻿" + lines.join("\r\n") + "\r\n", "utf8");

console.log("\n" + "─".repeat(70));
console.log(`Analysés : ${analysed} / ${SKUS.length}`);
console.log(`Changeraient d'image vedette : ${changedCount}`);
console.log(`CSV : docs/lifestyle-image-dry-run.csv`);
console.log("DRY-RUN — aucune écriture Shopify/DB.");
process.exit(0);
