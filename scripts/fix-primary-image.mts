/**
 * fix-primary-image — put the Aosom white-background primary (image1) at Shopify position 1.
 *
 * WHY: ameublodirect.ca should show the Aosom white-background shot (the image
 * Aosom orders first, i.e. `products.image1` in Turso) as the product's main
 * image. Some Shopify products have a lifestyle/other image at position 1.
 *
 * DETECTION (no URL keyword exists for "white bg" — it is purely positional):
 *   - The intended primary is the Aosom feed's `image1`.
 *   - Match it against Shopify images by the AOSOM HASH STEM. Shopify appends a
 *     `_<uuid>` suffix on ingest, so `BCf8da194939d07c8.jpg` (Aosom) and
 *     `BCf8da194939d07c8_5cadde4b-...jpg` (Shopify) are the SAME image.
 *     stem = basename → drop extension → take the token before the first "_".
 *
 * THREE OUTCOMES per product:
 *   - OK       : Shopify position 1 already IS the Aosom image1 (stem match). No action.
 *   - SWAP     : the Aosom image1 exists in Shopify but at position > 1 → reorder to 1.
 *   - NO_MATCH : the Aosom image1 is NOT in Shopify at all (the product's whole
 *                image set is stale vs the current feed). Reported only — fixing
 *                this needs a full image re-upload, a separate/riskier scope. NOT
 *                touched by --apply.
 *
 * USAGE (x64 Node — libsql has no win-arm64 build — with prod creds, through tsx):
 *   # dry-run (default — scans, writes CSV report, NO Shopify writes):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/fix-primary-image.mts
 *   # apply the reorders (SWAP rows only):
 *   …node_modules/tsx/dist/cli.mjs scripts/fix-primary-image.mts --apply
 *   # flags: --limit N (cap products, for testing) | --out path/to/report.csv
 *
 * RATE LIMIT: all Shopify calls serialized through a ~1.8 req/s throttle (550ms gap).
 */
import { createClient } from "@libsql/client";
import { writeFileSync, readFileSync } from "node:fs";

// Self-contained Shopify REST client (no @/ imports so this runs standalone under tsx).
const SHOPIFY_STORE = "27u5y2-kp.myshopify.com";
const SHOPIFY_API_VERSION = "2025-01";
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply") && !argv.includes("--dry-run");
const flagValue = (name: string): string | null => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1) || null;
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const LIMIT = flagValue("--limit") ? Number(flagValue("--limit")) : null;
const OUT = flagValue("--out") ?? "fix-primary-image-report.csv";
// --from-csv: apply only the SWAP rows of an existing dry-run report (deduped by
// shopify_product_id), instead of re-scanning all products. Much faster and the
// dedup makes multi-variant products deterministic (one reorder per product).
const FROM_CSV = flagValue("--from-csv");

// ── Shopify throttle (≤2 req/sec; 550ms gap ≈ 1.8 req/s) + 429 retry ─────────
const MIN_GAP_MS = 550;
let lastReq = 0;
async function throttledShopify(endpoint: string, init?: RequestInit, retry = 0): Promise<Response> {
  const wait = MIN_GAP_MS - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_TOKEN, ...init?.headers },
  });
  if (res.status === 429 && retry < 4) {
    const after = Number(res.headers.get("Retry-After") ?? "2");
    await new Promise((r) => setTimeout(r, Math.min(after, 10) * 1000));
    return throttledShopify(endpoint, init, retry + 1);
  }
  return res;
}

// ── Aosom hash stem ──────────────────────────────────────────────────────────
/** basename → drop ?query → drop extension → token before first "_" (Shopify ingest suffix). */
function stem(url: string | null | undefined): string {
  if (!url) return "";
  const fileName = url.split("?")[0].split("/").pop() ?? "";
  return fileName.replace(/\.[a-z0-9]+$/i, "").split("_")[0];
}

interface ShopImage { id: number; src: string; position: number; }
interface Row {
  sku: string;
  shopify_product_id: string;
  image_actuelle_url: string;
  image_aosom_position1_url: string;
  action: "OK" | "SWAP" | "NO_MATCH" | "ERROR";
  detail: string; // e.g. "from pos6 (img_id 123)" for SWAP, HTTP status for ERROR
}

function csvCell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

/** Parse one CSV line of all-quoted, ""-escaped cells. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') { i++; continue; }
    i++; // opening quote
    let cell = "";
    while (i < line.length) {
      if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (line[i] === '"') { i++; break; }
      cell += line[i++];
    }
    out.push(cell);
    while (i < line.length && line[i] !== '"') i++; // skip comma/separator
  }
  return out;
}

/**
 * APPLY from an existing dry-run CSV: take SWAP rows only, dedupe by
 * shopify_product_id (first wins), re-fetch each product fresh, and reorder the
 * Aosom image1 to position 1. Re-confirming state avoids acting on stale rows.
 */
async function applyFromCsv(csvPath: string): Promise<void> {
  console.log(`\n🖼️  fix-primary-image — APPLY from CSV (${csvPath}), SWAP rows deduped by product\n`);
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(","); // header is plain (unquoted) — no embedded commas
  const idx = (name: string) => header.indexOf(name);
  const iSku = idx("sku"), iPid = idx("shopify_product_id"),
    iAosom = idx("image_aosom_position1_url"), iAction = idx("action");

  const seen = new Set<string>();
  const targets: { sku: string; pid: string; aosom1: string }[] = [];
  let swapRows = 0;
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c[iAction] !== "SWAP") continue;
    swapRows++;
    if (seen.has(c[iPid])) continue; // dedupe by product — first variant wins
    seen.add(c[iPid]);
    targets.push({ sku: c[iSku], pid: c[iPid], aosom1: c[iAosom] });
  }
  console.log(`${swapRows} SWAP rows → ${targets.length} distinct products to reorder (deduped).\n`);

  // Preview mode: --from-csv without --apply prints the plan and stops (no writes).
  if (!APPLY) { console.log("PREVIEW only (no --apply) — no Shopify writes. Re-run with --apply to execute."); return; }

  let moved = 0, alreadyOk = 0, gone = 0, failed = 0, n = 0;
  for (const t of targets) {
    n++;
    const a1 = stem(t.aosom1);
    let res: Response;
    try { res = await throttledShopify(`/products/${encodeURIComponent(t.pid)}/images.json`); }
    catch (err) { failed++; console.log(`  ✗ ${t.sku} (${t.pid}) GET err ${(err as Error).message}`); continue; }
    if (!res.ok) { failed++; console.log(`  ✗ ${t.sku} (${t.pid}) GET HTTP ${res.status}`); continue; }

    const imgs = ((await res.json() as { images?: ShopImage[] }).images ?? []).slice().sort((a, b) => a.position - b.position);
    if (imgs[0] && stem(imgs[0].src) === a1) { alreadyOk++; continue; } // already correct (state changed since dry-run)
    const target = imgs.find((i) => stem(i.src) === a1);
    if (!target) { gone++; console.log(`  ⚠ ${t.sku} (${t.pid}) image1 no longer in Shopify — skipped`); continue; }

    try {
      const put = await throttledShopify(
        `/products/${encodeURIComponent(t.pid)}/images/${target.id}.json`,
        { method: "PUT", body: JSON.stringify({ image: { id: target.id, position: 1 } }) },
      );
      if (put.ok) { moved++; if (n % 25 === 0 || n === targets.length) console.log(`  …${n}/${targets.length} (moved=${moved})`); }
      else { failed++; console.log(`  ✗ ${t.sku} (${t.pid}) PUT HTTP ${put.status}`); }
    } catch (err) { failed++; console.log(`  ✗ ${t.sku} (${t.pid}) PUT err ${(err as Error).message}`); }
  }

  console.log(`\n=== APPLY SUMMARY (${targets.length} products) ===`);
  console.log(`  moved to pos1 : ${moved}`);
  console.log(`  already ok    : ${alreadyOk}  (state changed since dry-run)`);
  console.log(`  image1 gone   : ${gone}  (skipped)`);
  console.log(`  failed        : ${failed}`);
}

async function main(): Promise<void> {
  // Targeted path: reorder only the SWAP products from an existing report
  // (--apply executes; --from-csv alone previews the deduped plan, no writes).
  if (FROM_CSV) { await applyFromCsv(FROM_CSV); return; }

  console.log(`\n🖼️  fix-primary-image — ${APPLY ? "APPLY (reorder SWAP rows)" : "DRY-RUN (report only, no writes)"}` +
    `${LIMIT ? ` — limit ${LIMIT}` : ""}\n`);

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const sql =
    "SELECT sku, shopify_product_id, image1 FROM products " +
    "WHERE shopify_product_id IS NOT NULL AND image1 IS NOT NULL " +
    "ORDER BY rowid" + (LIMIT ? ` LIMIT ${LIMIT}` : "");
  const products = (await db.execute(sql)).rows as unknown as
    { sku: string; shopify_product_id: string; image1: string }[];

  console.log(`Scanning ${products.length} products (Shopify GET each, ~${Math.ceil(products.length / 1.8 / 60)} min)…\n`);

  const rows: Row[] = [];
  const counts = { OK: 0, SWAP: 0, NO_MATCH: 0, ERROR: 0 };
  let applied = 0, applyFailed = 0;
  let n = 0;

  for (const p of products) {
    n++;
    const aosom1 = p.image1;
    const aosom1Stem = stem(aosom1);

    let res: Response;
    try {
      res = await throttledShopify(`/products/${encodeURIComponent(p.shopify_product_id)}/images.json`);
    } catch (err) {
      const row: Row = { sku: p.sku, shopify_product_id: p.shopify_product_id, image_actuelle_url: "",
        image_aosom_position1_url: aosom1, action: "ERROR", detail: `fetch: ${(err as Error).message}` };
      rows.push(row); counts.ERROR++; continue;
    }
    if (!res.ok) {
      rows.push({ sku: p.sku, shopify_product_id: p.shopify_product_id, image_actuelle_url: "",
        image_aosom_position1_url: aosom1, action: "ERROR", detail: `HTTP ${res.status}` });
      counts.ERROR++; continue;
    }

    const data = (await res.json()) as { images?: ShopImage[] };
    const imgs = (data.images ?? []).slice().sort((a, b) => a.position - b.position);
    const shopPos1 = imgs[0];
    const shopPos1Src = shopPos1?.src ?? "";

    let action: Row["action"];
    let detail = "";
    let swapTarget: ShopImage | undefined;

    if (imgs.length === 0) {
      action = "NO_MATCH"; detail = "product has no Shopify images";
    } else if (stem(shopPos1Src) === aosom1Stem) {
      action = "OK";
    } else {
      swapTarget = imgs.find((i) => stem(i.src) === aosom1Stem);
      if (swapTarget) { action = "SWAP"; detail = `from pos${swapTarget.position} (img_id ${swapTarget.id})`; }
      else { action = "NO_MATCH"; detail = "aosom image1 not present in Shopify (stale image set)"; }
    }

    const row: Row = {
      sku: p.sku, shopify_product_id: p.shopify_product_id,
      image_actuelle_url: shopPos1Src, image_aosom_position1_url: aosom1, action, detail,
    };

    // ── APPLY: reorder SWAP targets to position 1 ──
    if (APPLY && action === "SWAP" && swapTarget) {
      try {
        const put = await throttledShopify(
          `/products/${encodeURIComponent(p.shopify_product_id)}/images/${swapTarget.id}.json`,
          { method: "PUT", body: JSON.stringify({ image: { id: swapTarget.id, position: 1 } }) },
        );
        if (put.ok) { applied++; row.detail += " → moved to pos1 ✓"; }
        else { applyFailed++; row.action = "ERROR"; row.detail += ` → PUT HTTP ${put.status}`; }
      } catch (err) {
        applyFailed++; row.action = "ERROR"; row.detail += ` → PUT err ${(err as Error).message}`;
      }
    }

    rows.push(row);
    // Count by the row's final action: a SWAP whose PUT failed above is now ERROR.
    counts[row.action]++;
    if (n % 100 === 0) console.log(`  …${n}/${products.length}  (OK=${counts.OK} SWAP=${counts.SWAP} NO_MATCH=${counts.NO_MATCH} ERR=${counts.ERROR})`);
  }

  // ── CSV ──
  const header = "sku,shopify_product_id,image_actuelle_url,image_aosom_position1_url,action,detail";
  const csv = [header, ...rows.map((r) => [
    r.sku, r.shopify_product_id, r.image_actuelle_url, r.image_aosom_position1_url, r.action, r.detail,
  ].map(csvCell).join(","))].join("\n");
  writeFileSync(OUT, csv, "utf8");

  console.log(`\n=== SUMMARY (${products.length} products) ===`);
  console.log(`  OK (image1 already pos1) : ${counts.OK}`);
  console.log(`  SWAP (reorder to pos1)   : ${counts.SWAP}`);
  console.log(`  NO_MATCH (image1 absent) : ${counts.NO_MATCH}`);
  console.log(`  ERROR                    : ${counts.ERROR}`);
  if (APPLY) console.log(`  APPLIED reorders         : ${applied}  (failed: ${applyFailed})`);
  console.log(`\nCSV report → ${OUT}`);
  if (!APPLY) console.log(`Re-run with --apply to reorder the ${counts.SWAP} SWAP product(s). NO_MATCH products are NOT auto-fixed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
