// scripts/populate-new-video-ugc.mjs — write products.video_ugc for the newly downloaded
// UGC clips that PASSED the compliance scan. Dry-run by default; --apply to write.
//
//   node-x64 --env-file=.env.local scripts/populate-new-video-ugc.mjs [--apply]
//
// Deliberately runs AFTER the compliance scan and deletion, so a rejected clip never
// leaves a dangling video_ugc row pointing at a file we removed.
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const manifest = JSON.parse(readFileSync("docs/new-ugc-manifest.json", "utf8"));
const scan = JSON.parse(readFileSync("docs/ugc-compliance-scan.json", "utf8"));
const rejected = new Set(scan.filter((s) => s.verdict === "NON CONFORME").map((s) => s.sku));

// A survivor: not rejected by the scan, and the file is actually on disk.
const survivors = manifest.filter((m) => !rejected.has(m.sku) && existsSync(`src/ugc/${m.sku}.mp4`));
const missing = manifest.filter((m) => !rejected.has(m.sku) && !existsSync(`src/ugc/${m.sku}.mp4`));

console.log(`Manifeste ${manifest.length} · rejetés ${rejected.size} · survivants ${survivors.length}${missing.length ? ` · MANQUANTS ${missing.length}` : ""}`);
if (missing.length) console.log(`  fichiers absents : ${missing.map((m) => m.sku).join(" ")}`);

const byC = {};
for (const s of survivors) byC[s.country] = (byC[s.country] || 0) + 1;
console.log(`Par pays : ${Object.entries(byC).sort().map(([c, n]) => `${c}=${n}`).join(" · ")}\n`);

// Only write rows that are currently empty, and report anything already set.
let written = 0, alreadySet = 0, notFound = 0;
for (const s of survivors) {
  const cur = await db.execute({ sql: `SELECT sku, video_ugc FROM products WHERE UPPER(sku) = ?`, args: [s.sku] });
  if (!cur.rows.length) { console.log(`✗ ${s.sku.padEnd(15)} absent de products`); notFound++; continue; }
  const existing = cur.rows[0].video_ugc ? String(cur.rows[0].video_ugc) : "";
  if (existing) { console.log(`= ${s.sku.padEnd(15)} déjà renseigné → ${existing}`); alreadySet++; continue; }
  if (APPLY) {
    await db.execute({ sql: `UPDATE products SET video_ugc = ? WHERE UPPER(sku) = ?`, args: [s.url, s.sku] });
  }
  console.log(`${APPLY ? "✓" : "·"} ${s.sku.padEnd(15)} [${s.country}] ${s.url}`);
  written++;
}

console.log(`\n${APPLY ? "ÉCRITS" : "À ÉCRIRE (dry-run)"} : ${written} · déjà renseignés ${alreadySet} · introuvables ${notFound}`);

const total = await db.execute(`SELECT COUNT(*) n FROM products WHERE video_ugc IS NOT NULL AND TRIM(video_ugc) <> ''`);
console.log(`Total products.video_ugc après opération : ${total.rows[0].n}`);
if (!APPLY) console.log(`\n(dry-run — relancer avec --apply pour écrire)`);
