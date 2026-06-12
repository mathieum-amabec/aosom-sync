// Force re-ingest of the Aosom MP4 for SKU 84B-146BU.
//
// The product already carries a READY video; "re-ingest" here means REPLACE.
// Ordering is upload-new-THEN-delete-old so a mid-pipeline failure can never
// strand the live product with no video (worst case: the product briefly holds
// both videos, which is recoverable — never zero):
//   1. GET the MP4 bytes from Turso products.video (timeout + size cap)
//   2. stagedUploadsCreate(resource: VIDEO, fileSize, mimeType)
//   3. POST the bytes to the staged GCS target (params first, file last)
//   4. productCreateMedia(originalSource: resourceUrl, VIDEO)   [new video attached]
//   5. poll media status UPLOADED->PROCESSING->READY/FAILED
//   6. ONLY once the new media is READY, delete the prior VIDEO media
//   7. upsert the outcome in video_ingest_log (Turso)
//
// Same validated pipeline as scripts/aosom-video-ingest-batch.mjs, scoped to one SKU.
import { loadEnv, gql, sleep } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const SKU = "84B-146BU";
const TODAY = "2026-06-11"; // matches existing log convention; Date.* avoided per harness
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

function productGid(id) {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`;
}

// gql() throws on json.errors but not on a 2xx {data:null} (throttle/permission
// edge). Guard the data envelope so an unexpected null fails loudly here rather
// than as an opaque "cannot read properties of null" mid-pipeline.
function dataOf(res, path) {
  if (!res || !res.data) throw new Error(`empty GraphQL data for ${path}`);
  return res.data;
}

// ── 0. load the product row + current media ──────────────────────────────────
const prow = await db.execute({
  sql: `SELECT sku, name, video, shopify_product_id FROM products WHERE sku = ?`,
  args: [SKU],
});
if (!prow.rows[0]) throw new Error(`no products row for ${SKU}`);
const p = {
  sku: String(prow.rows[0].sku),
  name: String(prow.rows[0].name ?? ""),
  video: String(prow.rows[0].video ?? ""),
  shopify_product_id: prow.rows[0].shopify_product_id != null ? String(prow.rows[0].shopify_product_id) : null,
};
if (!p.video) throw new Error(`no video URL in Turso for ${SKU}`);
if (!p.shopify_product_id) throw new Error(`no shopify_product_id for ${SKU}`);
const gid = productGid(p.shopify_product_id);
console.log(`SKU ${p.sku} → ${gid}`);
console.log(`video: ${p.video}`);

// record the existing VIDEO media ids now, but delete them only after the
// replacement is READY (step 6).
const ex = await gql(
  `query($id:ID!){ product(id:$id){ media(first:50){ nodes{ mediaContentType status ... on Video { id } } } } }`,
  { id: gid }
);
const priorVideoIds = (dataOf(ex, "product").product?.media?.nodes ?? [])
  .filter((n) => n.mediaContentType === "VIDEO" && n.id)
  .map((n) => n.id);
console.log(priorVideoIds.length ? `existing video(s) to replace: ${priorVideoIds.join(", ")}` : "no existing video media");

let mediaId = null;
let status = "UNKNOWN";
try {
  // ── 1. fetch bytes → exact size (timeout + size cap) ───────────────────────
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let buf;
  try {
    const vidRes = await fetch(p.video, { signal: ctrl.signal });
    if (!vidRes.ok) throw new Error(`video GET ${vidRes.status}`);
    buf = Buffer.from(await vidRes.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
  if (buf.byteLength > MAX_VIDEO_BYTES) throw new Error(`too large ${buf.byteLength}`);
  const fileSize = String(buf.byteLength);
  const filename = (p.video.split("/").pop() || "video.mp4").split("?")[0];
  console.log(`downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB as ${filename}`);

  // ── 2. stage ───────────────────────────────────────────────────────────────
  const stagedRes = await gql(
    `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
    { input: [{ resource: "VIDEO", filename, mimeType: "video/mp4", httpMethod: "POST", fileSize }] }
  );
  const staged = dataOf(stagedRes, "stagedUploadsCreate").stagedUploadsCreate;
  if (staged.userErrors?.length) throw new Error(`staged userErrors: ${JSON.stringify(staged.userErrors)}`);
  const target = staged.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) throw new Error("no staged target returned");

  // ── 3. upload to GCS (timeout) ─────────────────────────────────────────────
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([buf], { type: "video/mp4" }), filename);
  const up = await fetch(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!up.ok) throw new Error(`upload POST ${up.status}: ${(await up.text()).slice(0, 200)}`);
  console.log(`uploaded to GCS → ${up.status}`);

  // ── 4. attach as product media (product now holds old + new) ───────────────
  const cmRes = await gql(
    `mutation($productId:ID!,$media:[CreateMediaInput!]!){ productCreateMedia(productId:$productId, media:$media){ media{ status ... on Video { id } } mediaUserErrors{ field message } } }`,
    { productId: gid, media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO", alt: p.name.slice(0, 120) }] }
  );
  const cm = dataOf(cmRes, "productCreateMedia").productCreateMedia;
  if (cm.mediaUserErrors?.length) throw new Error(`media userErrors: ${JSON.stringify(cm.mediaUserErrors)}`);
  mediaId = cm.media?.[0]?.id ?? null;
  if (!mediaId) throw new Error("productCreateMedia returned no media id");
  console.log(`created media: ${mediaId}`);

  // ── 5. poll status → READY / FAILED (cap ~5 min: 20 × 15s) ─────────────────
  status = cm.media?.[0]?.status ?? "UPLOADED";
  for (let i = 0; i < 20 && status !== "READY" && status !== "FAILED"; i++) {
    await sleep(15000);
    const pr = await gql(`query($id:ID!){ node(id:$id){ ... on Video { id status } } }`, { id: mediaId });
    status = pr.data?.node?.status ?? status;
    console.log(`  poll ${i + 1}: ${status}`);
  }

  // ── 6. replacement is READY → delete the prior video(s). On any non-READY
  //       outcome, leave the old video intact so the live product never goes dark.
  if (status === "READY" && priorVideoIds.length) {
    const del = await gql(
      `mutation($mediaIds:[ID!]!,$productId:ID!){ productDeleteMedia(mediaIds:$mediaIds, productId:$productId){ deletedMediaIds mediaUserErrors{ field message } } }`,
      { mediaIds: priorVideoIds, productId: gid }
    );
    const delData = dataOf(del, "productDeleteMedia").productDeleteMedia;
    if (delData.mediaUserErrors?.length) {
      // New video is live; failing to delete the old one leaves 2 videos (recoverable).
      console.warn(`  WARN could not delete prior video(s): ${JSON.stringify(delData.mediaUserErrors)}`);
    } else {
      console.log(`  deleted prior video(s): ${JSON.stringify(delData.deletedMediaIds)}`);
    }
  } else if (status !== "READY") {
    console.warn(`  new media status ${status} (not READY) — prior video(s) left in place, not deleted`);
  }
} catch (err) {
  status = status === "READY" ? status : "ERROR";
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  pipeline error: ${msg}`);
  await upsertLog(mediaId, status, msg);
  console.log("─".repeat(60));
  console.log(`RESULT: ${SKU} → ${mediaId ?? "—"} → ${status} (prior video left in place if not READY)`);
  process.exit(1);
}

// ── 7. upsert video_ingest_log ───────────────────────────────────────────────
await upsertLog(mediaId, status, status === "READY" ? null : `media status ${status} (not READY)`);

console.log("─".repeat(60));
console.log(`RESULT: ${SKU} → ${mediaId} → ${status}`);
process.exit(status === "READY" ? 0 : 1);

async function upsertLog(media, st, error) {
  await db.execute(`CREATE TABLE IF NOT EXISTS video_ingest_log (
    sku TEXT PRIMARY KEY, product_id TEXT, media_id TEXT, status TEXT, video_url TEXT, created_at TEXT, error TEXT)`);
  await db.batch([
    { sql: `DELETE FROM video_ingest_log WHERE sku = ?`, args: [SKU] },
    {
      sql: `INSERT INTO video_ingest_log (sku, product_id, media_id, status, video_url, created_at, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [SKU, gid, media, st, p.video, TODAY, error],
    },
  ], "write");
}
