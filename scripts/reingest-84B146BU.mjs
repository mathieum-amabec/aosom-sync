// Force re-ingest of the Aosom MP4 for SKU 84B-146BU.
//
// The product already carries a READY video; "re-ingest" here means REPLACE:
//   0. delete the existing VIDEO media on the product (productDeleteMedia)
//   1. GET the MP4 bytes from Turso products.video (→ exact fileSize)
//   2. stagedUploadsCreate(resource: VIDEO, fileSize, mimeType)
//   3. POST the bytes to the staged GCS target (params first, file last)
//   4. productCreateMedia(originalSource: resourceUrl, VIDEO)
//   5. poll media status UPLOADED→PROCESSING→READY/FAILED
//   6. upsert the outcome in video_ingest_log (Turso)
//
// Same validated pipeline as scripts/aosom-video-ingest-batch.mjs, scoped to one SKU.
import { loadEnv, gql, sleep } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const SKU = "84B-146BU";
const TODAY = "2026-06-11"; // matches existing log convention; Date.* avoided per harness

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

function productGid(id) {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`;
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

// find existing VIDEO media to delete
const ex = await gql(
  `query($id:ID!){ product(id:$id){ media(first:50){ nodes{ mediaContentType status ... on Video { id } } } } }`,
  { id: gid }
);
const existingVideos = (ex.data.product?.media?.nodes ?? []).filter((n) => n.mediaContentType === "VIDEO" && n.id);
if (existingVideos.length) {
  const ids = existingVideos.map((v) => v.id);
  console.log(`deleting ${ids.length} existing video media: ${ids.join(", ")}`);
  const del = await gql(
    `mutation($mediaIds:[ID!]!,$productId:ID!){ productDeleteMedia(mediaIds:$mediaIds, productId:$productId){ deletedMediaIds mediaUserErrors{ field message } } }`,
    { mediaIds: ids, productId: gid }
  );
  const derr = del.data.productDeleteMedia.mediaUserErrors;
  if (derr?.length) throw new Error(`productDeleteMedia userErrors: ${JSON.stringify(derr)}`);
  console.log(`deleted: ${JSON.stringify(del.data.productDeleteMedia.deletedMediaIds)}`);
} else {
  console.log("no existing video media to delete");
}

// ── 1. fetch bytes → exact size ──────────────────────────────────────────────
const vidRes = await fetch(p.video);
if (!vidRes.ok) throw new Error(`video GET ${vidRes.status}`);
const buf = Buffer.from(await vidRes.arrayBuffer());
if (buf.byteLength > 500 * 1024 * 1024) throw new Error(`too large ${buf.byteLength}`);
const fileSize = String(buf.byteLength);
const filename = (p.video.split("/").pop() || "video.mp4").split("?")[0];
console.log(`downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB as ${filename}`);

// ── 2. stage ─────────────────────────────────────────────────────────────────
const stagedRes = await gql(
  `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
  { input: [{ resource: "VIDEO", filename, mimeType: "video/mp4", httpMethod: "POST", fileSize }] }
);
const staged = stagedRes.data.stagedUploadsCreate;
if (staged.userErrors?.length) throw new Error(`staged userErrors: ${JSON.stringify(staged.userErrors)}`);
const target = staged.stagedTargets?.[0];
if (!target?.url || !target?.resourceUrl) throw new Error("no staged target returned");

// ── 3. upload to GCS ─────────────────────────────────────────────────────────
const form = new FormData();
for (const param of target.parameters) form.append(param.name, param.value);
form.append("file", new Blob([buf], { type: "video/mp4" }), filename);
const up = await fetch(target.url, { method: "POST", body: form });
if (!up.ok) throw new Error(`upload POST ${up.status}: ${(await up.text()).slice(0, 200)}`);
console.log(`uploaded to GCS → ${up.status}`);

// ── 4. attach as product media ───────────────────────────────────────────────
const cmRes = await gql(
  `mutation($productId:ID!,$media:[CreateMediaInput!]!){ productCreateMedia(productId:$productId, media:$media){ media{ status ... on Video { id } } mediaUserErrors{ field message } } }`,
  { productId: gid, media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO", alt: p.name.slice(0, 120) }] }
);
const cm = cmRes.data.productCreateMedia;
if (cm.mediaUserErrors?.length) throw new Error(`media userErrors: ${JSON.stringify(cm.mediaUserErrors)}`);
const mediaId = cm.media?.[0]?.id ?? null;
console.log(`created media: ${mediaId}`);

// ── 5. poll status → READY / FAILED (cap ~5 min: 20 × 15s) ───────────────────
let status = cm.media?.[0]?.status ?? "UPLOADED";
if (mediaId) {
  for (let i = 0; i < 20 && status !== "READY" && status !== "FAILED"; i++) {
    await sleep(15000);
    const { data } = await gql(`query($id:ID!){ node(id:$id){ ... on Video { id status } } }`, { id: mediaId });
    status = data?.node?.status ?? status;
    console.log(`  poll ${i + 1}: ${status}`);
  }
}

// ── 6. upsert video_ingest_log ───────────────────────────────────────────────
await db.execute(`CREATE TABLE IF NOT EXISTS video_ingest_log (
  sku TEXT PRIMARY KEY, product_id TEXT, media_id TEXT, status TEXT, video_url TEXT, created_at TEXT, error TEXT)`);
await db.batch([
  { sql: `DELETE FROM video_ingest_log WHERE sku = ?`, args: [SKU] },
  {
    sql: `INSERT INTO video_ingest_log (sku, product_id, media_id, status, video_url, created_at, error)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [SKU, gid, mediaId, status, p.video, TODAY, status === "FAILED" ? "media processing FAILED" : null],
  },
], "write");

console.log("─".repeat(60));
console.log(`RESULT: ${SKU} → ${mediaId} → ${status}`);
process.exit(status === "READY" ? 0 : 1);
