// Theme edit: add a tag-driven "Populaire — Revenez bientôt" badge to the
// preview theme (160213696617) for products tagged `out-of-stock`.
//
// Two assets, via the Shopify Asset API:
//   1. sections/main-product.liquid — a <div class="popular-badge"> after the
//      product <h1>, plus the .popular-badge CSS appended to the existing
//      {%- style -%} block.
//   2. snippets/card-product.liquid — a <span class="badge badge--bottom-left
//      popular-badge-card">⭐ Populaire</span> inside BOTH card__badge divs
//      (the no-media and media card variants).
//
// Usage (Windows ARM64 → x64 node; bun-x64 crashes on network scripts):
//   node scripts/apply-out-of-stock-badge.mjs           # dry-run (default): no PUT
//   node scripts/apply-out-of-stock-badge.mjs --apply   # PUT to the theme
//
// Reads SHOPIFY_ACCESS_TOKEN from .env.local. Idempotent: each edit is skipped
// if its marker (popular-badge / popular-badge-card) is already present.
// Targets the PREVIEW theme only — never the live theme.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEME_ID = "160213696617";
const STORE = "27u5y2-kp.myshopify.com";
const API = `https://${STORE}/admin/api/2024-01`;
const APPLY = process.argv.includes("--apply");

function token() {
  const txt = readFileSync(join(ROOT, ".env.local"), "utf8");
  for (const l of txt.split(/\r?\n/)) {
    const m = l.match(/^\s*SHOPIFY_ACCESS_TOKEN\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("SHOPIFY_ACCESS_TOKEN not found in .env.local");
}
const TOKEN = token();
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

async function getAsset(key) {
  const r = await fetch(`${API}/themes/${THEME_ID}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${key} -> HTTP ${r.status}`);
  return (await r.json()).asset.value;
}
async function putAsset(key, value) {
  const r = await fetch(`${API}/themes/${THEME_ID}/assets.json`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ asset: { key, value } }),
  });
  return { ok: r.ok, status: r.status };
}

// ── ÉTAPE 1: main-product.liquid ────────────────────────────────────────────
const H1_ANCHOR = /(^[ \t]*)<h1>\{\{ lc_product_title \| escape \}\}<\/h1>/m;
const ENDSTYLE = "{%- endstyle -%}";
const POPULAR_CSS = `  .popular-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.75rem 0;
    padding: 0.4rem 1rem;
    border-radius: 999px;
    background: #FEF3C7;
    color: #92400E;
    font-size: 0.875rem;
    font-weight: 600;
  }
`;
function badgeBlock(indent) {
  return (
    `\n${indent}{%- if product.tags contains 'out-of-stock' -%}\n` +
    `${indent}  <div class="popular-badge">\n` +
    `${indent}    ⭐ Article populaire — Revenez bientôt !\n` +
    `${indent}    <span>Inscrivez-vous pour être notifié</span>\n` +
    `${indent}  </div>\n` +
    `${indent}{%- endif -%}`
  );
}

function transformMainProduct(src) {
  if (src.includes("popular-badge")) return { skipped: "already contains popular-badge" };
  const h1 = src.match(H1_ANCHOR);
  if (!h1) return { error: "title <h1> anchor not found" };
  if (!src.includes(ENDSTYLE)) return { error: "{%- endstyle -%} not found" };
  const indent = h1[1];
  let out = src.replace(H1_ANCHOR, (m) => m + badgeBlock(indent));
  // Append CSS just before the FIRST {%- endstyle -%}.
  out = out.replace(ENDSTYLE, POPULAR_CSS + ENDSTYLE);
  return { out, indent };
}

// ── ÉTAPE 2: card-product.liquid ────────────────────────────────────────────
const CARD_BADGE_OPEN = `<div class="card__badge {{ settings.badge_position }}">`;
const CARD_INSERT =
  `\n          {%- if card_product.tags contains 'out-of-stock' -%}\n` +
  `            <span class="badge badge--bottom-left popular-badge-card">⭐ Populaire</span>\n` +
  `          {%- endif -%}`;

// Amber CSS for the card badge. main-product.liquid's style block only loads on
// the PDP, so the card rule must travel with the card snippet (collection/search
// pages). Prepended once at the top of the file via a {% style %} block.
const CARD_STYLE =
  `{% style %}\n` +
  `  .popular-badge-card { background: #FEF3C7; color: #92400E; }\n` +
  `{% endstyle %}\n`;

function transformCardProduct(src) {
  if (src.includes("popular-badge-card")) return { skipped: "already contains popular-badge-card" };
  const occurrences = src.split(CARD_BADGE_OPEN).length - 1;
  if (occurrences === 0) return { error: "card__badge open tag not found" };
  // Inject the tag badge after each card__badge opening div, and prepend the style once.
  const injected = src.split(CARD_BADGE_OPEN).join(CARD_BADGE_OPEN + CARD_INSERT);
  const out = CARD_STYLE + injected;
  return { out, occurrences };
}

// ── diff helper: print the changed region with a few lines of context ────────
function showInsertionContext(label, newSrc, needle, ctx = 3) {
  const lines = newSrc.split(/\r?\n/);
  const idxs = [];
  lines.forEach((ln, i) => { if (ln.includes(needle)) idxs.push(i); });
  for (const idx of idxs) {
    const a = Math.max(0, idx - ctx), b = Math.min(lines.length, idx + ctx + 3);
    console.log(`  …${label} around line ${idx + 1}:`);
    for (let i = a; i < b; i++) console.log(`  ${String(i + 1).padStart(4)}${lines[i].includes(needle) || (i > idx && i < idx + 5) ? " +" : "  "}| ${lines[i].slice(0, 110)}`);
    console.log("");
  }
}

async function run() {
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — out-of-stock badge → preview theme ${THEME_ID}\n`);

  // ÉTAPE 1
  const mpSrc = await getAsset("sections/main-product.liquid");
  const mp = transformMainProduct(mpSrc);
  console.log("ÉTAPE 1 — sections/main-product.liquid");
  if (mp.skipped) console.log(`  SKIP (idempotent): ${mp.skipped}`);
  else if (mp.error) console.log(`  ✗ ${mp.error}`);
  else {
    console.log(`  h1 anchor matched (indent=${JSON.stringify(mp.indent)}); CSS appended before {%- endstyle -%}.`);
    console.log(`  size ${mpSrc.length} → ${mp.out.length} (+${mp.out.length - mpSrc.length})`);
    showInsertionContext("badge", mp.out, '<div class="popular-badge">');
    showInsertionContext("css", mp.out, ".popular-badge {");
  }

  // ÉTAPE 2
  const cpSrc = await getAsset("snippets/card-product.liquid");
  const cp = transformCardProduct(cpSrc);
  console.log("ÉTAPE 2 — snippets/card-product.liquid");
  if (cp.skipped) console.log(`  SKIP (idempotent): ${cp.skipped}`);
  else if (cp.error) console.log(`  ✗ ${cp.error}`);
  else {
    console.log(`  card__badge blocks found: ${cp.occurrences} (badge injected into each)`);
    console.log(`  size ${cpSrc.length} → ${cp.out.length} (+${cp.out.length - cpSrc.length})`);
    showInsertionContext("card-badge", cp.out, "popular-badge-card");
  }

  if (!APPLY) {
    console.log("DRY-RUN only — re-run with --apply to PUT to the theme.");
    return;
  }

  // PUTs
  if (mp.out) {
    const r = await putAsset("sections/main-product.liquid", mp.out);
    console.log(`[PUT] main-product.liquid -> HTTP ${r.status} ${r.ok ? "OK" : "FAIL"}`);
  }
  if (cp.out) {
    const r = await putAsset("snippets/card-product.liquid", cp.out);
    console.log(`[PUT] card-product.liquid -> HTTP ${r.status} ${r.ok ? "OK" : "FAIL"}`);
  }
  // Verify — the Asset API is read-after-write eventually consistent, so an
  // immediate GET can still return the pre-PUT copy. Retry with backoff before
  // declaring a marker missing.
  async function verify(key, marker) {
    for (let i = 0; i < 5; i++) {
      if ((await getAsset(key)).includes(marker)) return true;
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  }
  const mpOk = await verify("sections/main-product.liquid", "popular-badge");
  const cpOk = await verify("snippets/card-product.liquid", "popular-badge-card");
  console.log(`Verify: main-product popular-badge=${mpOk}; card-product popular-badge-card=${cpOk}`);
}

run().catch((e) => { console.error("✗ failed:", e); process.exit(1); });
