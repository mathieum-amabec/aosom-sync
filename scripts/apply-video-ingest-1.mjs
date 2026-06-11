// C3 — REAL Aosom video ingest, 1ST PRODUCT ONLY (Mat-authorized test).
// Flow: Turso → stagedUploadsCreate(VIDEO, PUT) → stream MP4 → PUT to GCS → productCreateMedia
// → poll to READY → log to Turso. STOP after product 1; the other 2 await Mat's validation.
import { loadEnv, gql, sleep } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const step = (n, s) => console.log(`\n── Étape ${n} — ${s} ──`);

// 1. Turso: first 3 products with a video + a Shopify id; take the 1st
step(1, "Turso: produit candidat");
const q = await db.execute(`SELECT sku, shopify_product_id, video FROM products
  WHERE video IS NOT NULL AND video != '' AND shopify_product_id IS NOT NULL
  ORDER BY sku LIMIT 3`);
if (!q.rows.length) { console.log("Aucun produit avec vidéo + shopify_product_id."); process.exit(0); }
console.log(`3 candidats: ${q.rows.map((r) => r.sku).join(", ")}`);
const p = q.rows[0];
const sku = String(p.sku), pidNum = String(p.shopify_product_id), video = String(p.video);
const productGid = pidNum.startsWith("gid://") ? pidNum : `gid://shopify/Product/${pidNum}`;
console.log(`→ 1er produit: ${sku}  product=${productGid}\n  video: ${video}`);

// Idempotency: skip if the product already has a video media
const existing = await gql(`query($id:ID!){ product(id:$id){ media(first:25){ nodes{ ... on Video { id status } } } } }`, { id: productGid });
const already = (existing.data.product?.media?.nodes || []).find((n) => n && n.id);
if (already) { console.log(`• le produit a déjà une vidéo (${already.id}, ${already.status}) — STOP (idempotent).`); process.exit(0); }

// 2. stagedUploadsCreate (VIDEO) — GCS POST form upload; needs fileSize
step(2, "stagedUploadsCreate(VIDEO, POST)");
let fileSize = "";
try { const h = await fetch(video, { method: "HEAD" }); fileSize = h.headers.get("content-length") || ""; console.log(`HEAD ${h.status} · ${fileSize} bytes · ${h.headers.get("content-type")}`); } catch (e) { console.log("HEAD:", e.message); }
const STAGED = `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`;
const sres = await gql(STAGED, { input: [{ resource: "VIDEO", filename: `${sku}.mp4`, mimeType: "video/mp4", httpMethod: "POST", ...(fileSize ? { fileSize } : {}) }] });
if (sres.data.stagedUploadsCreate.userErrors.length) throw new Error("staged: " + JSON.stringify(sres.data.stagedUploadsCreate.userErrors));
const target = sres.data.stagedUploadsCreate.stagedTargets[0];
console.log(`staged url host: ${new URL(target.url).host}\nresourceUrl: ${target.resourceUrl}\nparams: ${(target.parameters || []).map((x) => x.name).join(", ") || "(none)"}`);

// 3. download MP4 (≤500MB, 120s) then PUT bytes to staging
step(3, "Download MP4 (Aosom CDN) → PUT vers staging");
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 120000);
const dl = await fetch(video, { signal: ctrl.signal });
if (!dl.ok) throw new Error(`download ${dl.status}`);
const buf = Buffer.from(await dl.arrayBuffer());
clearTimeout(t);
if (buf.byteLength > 500 * 1024 * 1024) throw new Error(`MP4 too large: ${buf.byteLength}`);
console.log(`téléchargé: ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);
// GCS POST policy upload: form fields (parameters) first, then the file last.
const form = new FormData();
for (const pr of target.parameters || []) form.append(pr.name, pr.value);
form.append("file", new Blob([buf], { type: "video/mp4" }), `${sku}.mp4`);
const up = await fetch(target.url, { method: "POST", body: form });
console.log(`POST staging → HTTP ${up.status}`);
if (!up.ok) throw new Error(`staging POST failed ${up.status}: ${(await up.text()).slice(0, 300)}`);

// 4. productCreateMedia
step(4, "productCreateMedia");
const PCM = `mutation($pid:ID!,$media:[CreateMediaInput!]!){ productCreateMedia(productId:$pid, media:$media){ media{ id status ... on Video { id } } mediaUserErrors{ field message } } }`;
const cres = await gql(PCM, { pid: productGid, media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO" }] });
if (cres.data.productCreateMedia.mediaUserErrors.length) throw new Error("createMedia: " + JSON.stringify(cres.data.productCreateMedia.mediaUserErrors));
const media = cres.data.productCreateMedia.media[0];
console.log(`media id: ${media.id} · statut initial: ${media.status}`);

// 5. poll to READY (max 5 min, 15s)
step(5, "Polling statut → READY (max 5 min)");
let status = media.status;
for (let i = 0; i < 20 && status !== "READY" && status !== "FAILED"; i++) {
  await sleep(15000);
  const pr = await gql(`query($id:ID!){ node(id:$id){ ... on Video { id status } } }`, { id: media.id });
  status = pr.data.node?.status || status;
  console.log(`  [${(i + 1) * 15}s] ${status}`);
}
console.log(`→ statut final: ${status}`);

// 6. log to Turso
step(6, "Log Turso (video_ingest_log)");
await db.execute(`CREATE TABLE IF NOT EXISTS video_ingest_log (
  sku TEXT, product_id TEXT, media_id TEXT, status TEXT, video_url TEXT, created_at TEXT)`);
await db.execute({ sql: `INSERT INTO video_ingest_log (sku, product_id, media_id, status, video_url, created_at) VALUES (?,?,?,?,?,?)`,
  args: [sku, productGid, media.id, status, video, "2026-06-12"] });
console.log(`logged: ${sku} → ${media.id} → ${status}`);

console.log(`\n${status === "READY" ? "✅" : "⚠️"} 1er produit terminé (${sku}, ${status}). STOP — en attente de validation de Mat avant les 2 autres.`);
