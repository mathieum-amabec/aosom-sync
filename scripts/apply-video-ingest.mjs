// C1 — Aosom video ingest for the 3 test candidates (idempotent; skips products that
// already have a video). Same validated pipeline as apply-video-ingest-1.mjs.
import { loadEnv, gql, sleep } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
await db.execute(`CREATE TABLE IF NOT EXISTS video_ingest_log (
  sku TEXT, product_id TEXT, media_id TEXT, status TEXT, video_url TEXT, created_at TEXT)`);

const q = await db.execute(`SELECT sku, shopify_product_id, video FROM products
  WHERE video IS NOT NULL AND video != '' AND shopify_product_id IS NOT NULL
  ORDER BY sku LIMIT 3`);
console.log(`Candidats: ${q.rows.map((r) => r.sku).join(", ")}\n`);

let done = 0, already = 0;
for (const row of q.rows) {
  const sku = String(row.sku);
  const pidNum = String(row.shopify_product_id);
  const video = String(row.video);
  const productGid = pidNum.startsWith("gid://") ? pidNum : `gid://shopify/Product/${pidNum}`;
  console.log(`── ${sku}  (${productGid}) ──`);

  // idempotency
  const ex = await gql(`query($id:ID!){ product(id:$id){ media(first:25){ nodes{ ... on Video { id status } } } } }`, { id: productGid });
  const has = (ex.data.product?.media?.nodes || []).find((n) => n && n.id);
  if (has) { console.log(`  • déjà une vidéo (${has.id}, ${has.status}) — skip\n`); already++; continue; }

  // size
  let fileSize = "";
  try { const h = await fetch(video, { method: "HEAD" }); fileSize = h.headers.get("content-length") || ""; } catch {}

  // stagedUploadsCreate (VIDEO, POST/GCS policy)
  const sres = await gql(`mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
    { input: [{ resource: "VIDEO", filename: `${sku}.mp4`, mimeType: "video/mp4", httpMethod: "POST", ...(fileSize ? { fileSize } : {}) }] });
  if (sres.data.stagedUploadsCreate.userErrors.length) { console.log(`  FAIL staged: ${JSON.stringify(sres.data.stagedUploadsCreate.userErrors)}\n`); continue; }
  const target = sres.data.stagedUploadsCreate.stagedTargets[0];

  // download MP4 (≤500MB, 120s) → multipart POST to GCS
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  const dl = await fetch(video, { signal: ctrl.signal });
  if (!dl.ok) { clearTimeout(t); console.log(`  FAIL download ${dl.status}\n`); continue; }
  const buf = Buffer.from(await dl.arrayBuffer());
  clearTimeout(t);
  if (buf.byteLength > 500 * 1024 * 1024) { console.log(`  FAIL too large ${buf.byteLength}\n`); continue; }
  const form = new FormData();
  for (const pr of target.parameters || []) form.append(pr.name, pr.value);
  form.append("file", new Blob([buf], { type: "video/mp4" }), `${sku}.mp4`);
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) { console.log(`  FAIL GCS POST ${up.status}: ${(await up.text()).slice(0, 200)}\n`); continue; }
  console.log(`  upload ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB → GCS ${up.status}`);

  // productCreateMedia
  const cres = await gql(`mutation($pid:ID!,$media:[CreateMediaInput!]!){ productCreateMedia(productId:$pid, media:$media){ media{ id status ... on Video { id } } mediaUserErrors{ field message } } }`,
    { pid: productGid, media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO" }] });
  if (cres.data.productCreateMedia.mediaUserErrors.length) { console.log(`  FAIL createMedia: ${JSON.stringify(cres.data.productCreateMedia.mediaUserErrors)}\n`); continue; }
  const media = cres.data.productCreateMedia.media[0];

  // poll READY (max 5 min, 15s)
  let status = media.status;
  for (let i = 0; i < 20 && status !== "READY" && status !== "FAILED"; i++) {
    await sleep(15000);
    const pr = await gql(`query($id:ID!){ node(id:$id){ ... on Video { id status } } }`, { id: media.id });
    status = pr.data.node?.status || status;
  }
  console.log(`  media ${media.id} → ${status}`);

  // log
  await db.execute({ sql: `INSERT INTO video_ingest_log (sku, product_id, media_id, status, video_url, created_at) VALUES (?,?,?,?,?,?)`,
    args: [sku, productGid, media.id, status, video, "2026-06-12"] });
  if (status === "READY") done++;
  console.log(`  logged: ${sku} → ${media.id} → ${status}\n`);
}

console.log("─".repeat(60));
console.log(`Rapport final : ${already + done}/3 (${already} déjà fait + ${done} nouveaux READY).`);
