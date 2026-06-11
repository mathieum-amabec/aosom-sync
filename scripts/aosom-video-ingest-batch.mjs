// Phase 3 — BATCH ingestion of Aosom product MP4s into Shopify (top-30 sellers).
//
// Attaches each top-30 SKU's `products.video` Aosom MP4 to its Shopify product as
// a VIDEO media, via the product-media path (covered by `write_products` — the
// standalone Files API scopes are NOT needed; see docs/aosom-video-ingest-dry-run.md).
//
// Per SKU the full flow is:
//   1. GET the MP4 bytes (→ exact fileSize)                         [network]
//   2. stagedUploadsCreate(resource: VIDEO, fileSize, mimeType)     [GraphQL]
//   3. POST the bytes to the staged GCS target (params + file)      [upload]
//   4. productCreateMedia(originalSource: resourceUrl, VIDEO)       [GraphQL]
//   5. poll the media status UPLOADED→PROCESSING→READY/FAILED       [GraphQL]
//   6. log the outcome in `video_ingest_log` (Turso)
//
// Idempotent: a SKU already logged READY is skipped; a SKU whose Shopify product
// already carries a READY video is logged READY and skipped (covers the manually
// validated test products). Throttled to <=2 Shopify requests/sec.
//
// Modes:
//   node scripts/aosom-video-ingest-batch.mjs            # dry-run (default): list candidates
//   node scripts/aosom-video-ingest-batch.mjs --dry-run  # explicit dry-run
//   node scripts/aosom-video-ingest-batch.mjs --apply    # execute real ingestion
import { loadEnv, gql, sleep } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY; // default to dry-run unless --apply is explicit

// Top 30 by inferred stock velocity — docs/audit-pdp-video.md §6 (same source as the
// dry-run). 17 of these carry a products.video URL.
const TOP30 = [
  "84A-009BK", "84A-054V05BK", "845-792V00YL", "84K-241V00LG", "845-039V01GY",
  "845-652V00GY", "01-0893", "845-518GY", "84H-209V00CG", "845-774V00BK",
  "84G-791V00BK", "84A-009", "84C-142V01CG", "84A-009BN", "845-335",
  "84B-136BK", "844-610V00BK", "823-010V81", "84B-136", "370-198BK",
  "823-002V80", "84K-241V00CG", "867-034", "845-774V00SR", "84C-226CG",
  "84A-054V05BN", "D51-277V01", "84B-146BU", "824-024V80BK", "01-0902",
];

// ── throttle: <=2 Shopify GraphQL calls / second ─────────────────────────────
const RATE_MS = 500;
let lastCall = 0;
async function tgql(query, variables) {
  const dt = Date.now() - lastCall;
  if (dt < RATE_MS) await sleep(RATE_MS - dt);
  lastCall = Date.now();
  return gql(query, variables);
}

function productGid(id) {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`;
}

// ── GraphQL documents ────────────────────────────────────────────────────────
const STAGED = `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const CREATE_MEDIA = `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { alt mediaContentType status ... on Video { id } }
    mediaUserErrors { field message }
  }
}`;

const PRODUCT_MEDIA = `query($id: ID!) {
  product(id: $id) {
    media(first: 50) {
      nodes { mediaContentType status ... on Video { id } }
    }
  }
}`;

const NODE_STATUS = `query($id: ID!) {
  node(id: $id) { ... on Video { id status } }
}`;

// ── Turso: video_ingest_log ──────────────────────────────────────────────────
// The table is pre-existing (created during the 3-product manual validation) with
// columns (sku, product_id, media_id, status, video_url, created_at). We match that
// schema exactly; the CREATE below only fires on a fresh DB. We additively add a
// nullable `error` column (guarded) so failures are persisted too. sku has no UNIQUE
// constraint on the live table, so logResult upserts via delete-then-insert.
const TODAY = new Date().toISOString().slice(0, 10);

async function openLog(env) {
  const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  await db.execute(`CREATE TABLE IF NOT EXISTS video_ingest_log (
    sku TEXT PRIMARY KEY,
    product_id TEXT,
    media_id TEXT,
    status TEXT,
    video_url TEXT,
    created_at TEXT,
    error TEXT
  )`);
  const cols = await db.execute(`PRAGMA table_info(video_ingest_log)`);
  const names = new Set(cols.rows.map((r) => String(r.name)));
  if (!names.has("error")) await db.execute(`ALTER TABLE video_ingest_log ADD COLUMN error TEXT`);
  return db;
}

async function logResult(db, sku, fields) {
  // Atomic upsert: delete-then-insert in one transaction so a crash mid-write
  // can't drop the row (sku has no UNIQUE constraint on the live table).
  await db.batch([
    { sql: `DELETE FROM video_ingest_log WHERE sku = ?`, args: [sku] },
    {
      sql: `INSERT INTO video_ingest_log (sku, product_id, media_id, status, video_url, created_at, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [sku, fields.product_id ?? null, fields.media_id ?? null, fields.status,
             fields.video_url ?? null, TODAY, fields.error ?? null],
    },
  ], "write");
}

async function loggedStatus(db, sku) {
  const r = await db.execute({ sql: `SELECT status FROM video_ingest_log WHERE sku = ?`, args: [sku] });
  return r.rows[0] ? String(r.rows[0].status) : null;
}

// ── existing-media check (idempotency for products validated outside this log) ─
// Returns the existing READY video's media id, or null if the product has none.
async function existingReadyVideoId(gid) {
  const { data } = await tgql(PRODUCT_MEDIA, { id: gid });
  const nodes = data?.product?.media?.nodes ?? [];
  const v = nodes.find((n) => n.mediaContentType === "VIDEO" && n.status === "READY");
  return v?.id ?? null;
}

// ── one SKU, full flow ───────────────────────────────────────────────────────
async function ingestOne(p) {
  const gid = productGid(p.shopify_product_id);

  // Skip if Shopify already has a READY video on this product.
  const existing = await existingReadyVideoId(gid);
  if (existing) {
    return { status: "READY", media_id: existing, skipped: true, reason: "product already has READY video" };
  }

  // 1. fetch bytes → exact size
  const vidRes = await fetch(p.video);
  if (!vidRes.ok) throw new Error(`video GET ${vidRes.status}`);
  const buf = Buffer.from(await vidRes.arrayBuffer());
  const fileSize = String(buf.byteLength);
  const filename = (p.video.split("/").pop() || "video.mp4").split("?")[0];

  // 2. stage
  const stagedRes = await tgql(STAGED, {
    input: [{ resource: "VIDEO", filename, mimeType: "video/mp4", httpMethod: "POST", fileSize }],
  });
  const staged = stagedRes.data.stagedUploadsCreate;
  if (staged.userErrors?.length) throw new Error(`staged userErrors: ${JSON.stringify(staged.userErrors)}`);
  const target = staged.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) throw new Error("no staged target returned");

  // 3. upload bytes to the staged GCS target (signed params first, file last)
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([buf], { type: "video/mp4" }), filename);
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`upload POST ${up.status}: ${(await up.text()).slice(0, 200)}`);

  // 4. attach as product media
  const cmRes = await tgql(CREATE_MEDIA, {
    productId: gid,
    media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO", alt: p.name.slice(0, 120) }],
  });
  const cm = cmRes.data.productCreateMedia;
  if (cm.mediaUserErrors?.length) throw new Error(`media userErrors: ${JSON.stringify(cm.mediaUserErrors)}`);
  const mediaId = cm.media?.[0]?.id ?? null;

  // 5. poll status → READY / FAILED (cap ~2 min: 24 × 5s)
  let status = cm.media?.[0]?.status ?? "UPLOADED";
  if (mediaId) {
    for (let i = 0; i < 24 && status !== "READY" && status !== "FAILED"; i++) {
      await sleep(5000);
      const { data } = await tgql(NODE_STATUS, { id: mediaId });
      status = data?.node?.status ?? status;
    }
  }
  if (status === "FAILED") throw new Error("media processing FAILED");

  return { status, media_id: mediaId, skipped: false };
}

// ── main ─────────────────────────────────────────────────────────────────────
const env = loadEnv();
const db = await openLog(env);

const ph = TOP30.map(() => "?").join(",");
const r = await db.execute({
  sql: `SELECT sku, name, video, shopify_product_id FROM products
        WHERE sku IN (${ph}) AND video IS NOT NULL AND video != ''`,
  args: TOP30,
});
const candidates = r.rows.map((row) => ({
  sku: String(row.sku),
  name: String(row.name ?? ""),
  video: String(row.video),
  shopify_product_id: row.shopify_product_id != null ? String(row.shopify_product_id) : null,
}));

console.log(`=== Aosom video ingest — BATCH (${DRY ? "DRY-RUN" : "APPLY"}) ===`);
console.log(`Top-30 source: docs/audit-pdp-video.md §6 · ${candidates.length} SKUs carry a products.video URL.\n`);

// Variant SKUs can share one Shopify product → only the first SKU per product is
// ingested; siblings are skipped (one product carries one video).
function groupByProduct(list) {
  const byPid = new Map();
  for (const p of list.filter((x) => x.shopify_product_id)) {
    if (!byPid.has(p.shopify_product_id)) byPid.set(p.shopify_product_id, []);
    byPid.get(p.shopify_product_id).push(p.sku);
  }
  return byPid;
}

if (DRY) {
  let n = 0;
  for (const p of candidates) {
    n++;
    const prior = await loggedStatus(db, p.sku);
    const hasPid = p.shopify_product_id ? "✓" : "✗ NO shopify_product_id";
    console.log(`${String(n).padStart(2)}. ${p.sku} — ${p.name.slice(0, 48)}`);
    console.log(`    product: ${hasPid}${p.shopify_product_id ? ` (${p.shopify_product_id})` : ""} · log: ${prior ?? "—"}`);
    console.log(`    video:   ${p.video}`);
  }
  const ingestable = candidates.filter((p) => p.shopify_product_id);
  const blocked = candidates.filter((p) => !p.shopify_product_id);
  const byPid = groupByProduct(candidates);
  const dupes = [...byPid.entries()].filter(([, skus]) => skus.length > 1);
  console.log("\n" + "─".repeat(72));
  console.log(`DRY-RUN: ${candidates.length} candidats · ${ingestable.length} avec product_id · ${byPid.size} produits uniques · ${blocked.length} bloqués (pas de product_id).`);
  if (blocked.length) console.log(`  Bloqués: ${blocked.map((p) => p.sku).join(", ")}`);
  if (dupes.length) {
    console.log(`  Variantes partageant un produit (1 vidéo / produit — 1er SKU ingéré, les autres skippés):`);
    for (const [pid, skus] of dupes) console.log(`    ${pid}: ${skus.join(", ")} → ingère ${skus[0]}`);
  }
  console.log(`  → ${byPid.size} vidéos seront attachées en --apply.`);
  console.log("Aucune vidéo uploadée, aucun produit modifié. Relancer avec --apply après validation de Mat.");
  process.exit(0);
}

// ── APPLY ────────────────────────────────────────────────────────────────────
let ingested = 0, skipped = 0, errors = 0;
const processedPids = new Set(); // a product carries one video; skip sibling SKUs
for (const p of candidates) {
  const gid = p.shopify_product_id ? productGid(p.shopify_product_id) : null;
  if (!p.shopify_product_id) {
    console.log(`• ${p.sku} — SKIP (pas de shopify_product_id)`);
    await logResult(db, p.sku, { video_url: p.video, status: "SKIPPED", error: "no shopify_product_id" });
    skipped++;
    continue;
  }
  if (processedPids.has(p.shopify_product_id)) {
    console.log(`• ${p.sku} — SKIP (vidéo déjà attachée au produit ${p.shopify_product_id} via un SKU frère)`);
    await logResult(db, p.sku, { product_id: gid, video_url: p.video, status: "SKIPPED", error: "sibling SKU already ingested for this product" });
    skipped++;
    continue;
  }
  if ((await loggedStatus(db, p.sku)) === "READY") {
    console.log(`• ${p.sku} — SKIP (déjà READY dans video_ingest_log)`);
    processedPids.add(p.shopify_product_id);
    skipped++;
    continue;
  }
  try {
    const out = await ingestOne(p);
    if (out.skipped) {
      console.log(`• ${p.sku} — SKIP (${out.reason})`);
      await logResult(db, p.sku, { product_id: gid, media_id: out.media_id, video_url: p.video, status: "READY" });
      processedPids.add(p.shopify_product_id);
      skipped++;
    } else {
      console.log(`• ${p.sku} — ${out.status}${out.media_id ? ` (${out.media_id})` : ""}`);
      await logResult(db, p.sku, {
        product_id: gid, media_id: out.media_id, video_url: p.video, status: out.status,
      });
      if (out.status === "READY") { ingested++; processedPids.add(p.shopify_product_id); }
      else errors++;
    }
  } catch (e) {
    console.log(`• ${p.sku} — ERREUR: ${e.message}`);
    await logResult(db, p.sku, { product_id: gid, video_url: p.video, status: "ERROR", error: e.message });
    errors++;
  }
}

console.log("\n" + "─".repeat(72));
console.log(`RAPPORT: ${ingested} ingérés / ${skipped} skippés / ${errors} erreurs (sur ${candidates.length} candidats).`);
process.exit(errors > 0 ? 1 : 0);
