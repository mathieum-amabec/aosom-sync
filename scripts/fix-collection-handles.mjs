/**
 * Verify the article internal-link collection handles against the REAL Shopify
 * collection handles (Admin API), then correct any drift in docs/seo-articles/*.md.
 * Read-only against Shopify (GET only). Requires SHOPIFY_ACCESS_TOKEN.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2024-01";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "seo-articles");
const token = process.env.SHOPIFY_ACCESS_TOKEN;
if (!token) { console.error("ERROR: SHOPIFY_ACCESS_TOKEN not set"); process.exit(1); }

const slugify = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// The 12 real collection titles used as internal-link targets in the articles.
const TITLES = [
  "Mobiliers extérieurs et jardins", "Chaises et tables de patio", "Gazébos et abris extérieurs",
  "Fauteuils et canapés", "Salon", "Entrée et vestibule", "Meubles et décorations",
  "Cuisine et salle à manger", "Chats", "Accessoires pour animaux",
  "Jouets pour enfants", "Meubles pour enfants",
];

async function fetchCollections(kind) {
  const url = `https://${STORE}/admin/api/${API}/${kind}.json?fields=id,handle,title&limit=250`;
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
  if (!r.ok) throw new Error(`${kind}: HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j[kind] ?? [];
}

const [custom, smart] = await Promise.all([
  fetchCollections("custom_collections"),
  fetchCollections("smart_collections"),
]);
const all = [...custom, ...smart];
console.log(`Fetched ${custom.length} custom + ${smart.length} smart = ${all.length} collections.\n`);

// Real title (trimmed) -> handle. First match wins.
const byTitle = new Map();
for (const c of all) { const k = (c.title || "").trim(); if (!byTitle.has(k)) byTitle.set(k, c.handle); }

const corrections = []; // {derived, real}
const unmatched = [];
console.log("TITLE  |  derived  ->  real  |  status");
console.log("-".repeat(78));
for (const t of TITLES) {
  const derived = slugify(t);
  const real = byTitle.get(t.trim());
  if (!real) { unmatched.push(t); console.log(`${t}  |  ${derived}  ->  (introuvable)  |  ⚠ UNMATCHED`); continue; }
  if (real === derived) { console.log(`${t}  |  ${derived}  ==  ${real}  |  ✓ OK`); }
  else { corrections.push({ derived, real, title: t }); console.log(`${t}  |  ${derived}  ->  ${real}  |  ✏ CORRIGÉ`); }
}

// Apply corrections to the article files.
let filesChanged = 0, urlsFixed = 0;
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
for (const f of files) {
  const p = join(DIR, f);
  let txt = readFileSync(p, "utf8");
  const before = txt;
  for (const { derived, real } of corrections) {
    const re = new RegExp(`/collections/${derived}(?=[)\\s"'])`, "g");
    const n = (txt.match(re) || []).length;
    if (n) { txt = txt.replace(re, `/collections/${real}`); urlsFixed += n; }
  }
  // Mark matched footer links as verified (anything we could resolve = matched).
  const matchedTitles = new Set([...corrections.map((c) => c.title), ...TITLES.filter((t) => byTitle.get(t.trim()) && slugify(t) === byTitle.get(t.trim()))]);
  for (const t of matchedTitles) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    txt = txt.replace(new RegExp(`(\\[${esc}\\]\\([^)]+\\)) _\\(handle à vérifier\\)_`, "g"), "$1 _(handle vérifié ✓)_");
  }
  if (txt !== before) { writeFileSync(p, txt, "utf8"); filesChanged++; }
}

console.log(`\nUnmatched titles: ${unmatched.length ? unmatched.join(", ") : "none"}`);
console.log(`Corrections: ${corrections.length} handle(s) | ${urlsFixed} URL(s) fixed across ${filesChanged} file(s).`);
