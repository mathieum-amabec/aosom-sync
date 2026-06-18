// YouTube uploader for Demand Gen — pushes the 16:9 assets recorded in
// `video_demand_gen` to YouTube via Data API v3 (videos.insert, resumable),
// then writes youtube_video_id + youtube_status back into the row.
//
// Plain ESM (.mjs) so it runs under node x64 with global fetch — no TS loader,
// no googleapis SDK (raw fetch against the OAuth + resumable-upload endpoints,
// mirroring scripts/upload-demand-gen.mjs).
//
//   node scripts/upload-youtube.mjs                 # DRY-RUN (default) — reads the DB, no upload, no quota
//   node scripts/upload-youtube.mjs --apply         # real upload (consumes YouTube quota!)
//   node scripts/upload-youtube.mjs --apply --limit 3   # cap uploads this run (quota guard)
//   node scripts/upload-youtube.mjs --apply --force # re-upload rows that already have a youtube_video_id
//
// ⚠ QUOTA: videos.insert costs ~1600 units; the default daily quota is 10000
//    → ~6 uploads/day. DRY-RUN first, checkpoint, then --apply in small batches.
//
// Source of truth: video_demand_gen WHERE ratio='16:9'. The MP4 bytes are fetched
// from blob_url (so this runs from any clone — no local out/demand-gen needed).
// Idempotent: rows already carrying a youtube_video_id are skipped unless --force.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return Infinity;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error("✗ --limit needs a positive integer (e.g. --limit 3)");
    process.exit(2);
  }
  return n;
})();

const RATIO = "16:9";
const PRIVACY = "unlisted";
const STORE_HOME = "https://ameublodirect.ca";
const PRODUCT_BASE = `${STORE_HOME}/products`;
const QUOTA_PER_INSERT = 1600; // Data API v3 cost of videos.insert
const DAILY_QUOTA = 10000;
const RATE_MS = 1000; // be gentle; uploads are large + quota-bound anyway

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => (bytes / 1048576).toFixed(2);

// --- env (.env.local) — read manually, never printed -------------------
function loadEnv() {
  const candidates = [join(ROOT, ".env.local"), join(HERE, "..", ".env.local")];
  const env = {};
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in env)) env[m[1]] = v; // first file wins
    }
    break; // first existing file wins
  }
  // process.env overrides file (CI / manual export)
  for (const k of [
    "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
    "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN",
  ]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

const env = loadEnv();

// --- metadata helpers ----------------------------------------------------
function videoTitle(row) {
  const t = (row.title_fr && String(row.title_fr).trim()) || `Démo produit ${row.sku}`;
  return t.slice(0, 100); // YouTube hard limit
}
function videoDescription(row, handleMap) {
  // Storefront resolves products by HANDLE, not by the numeric/GID id stored in
  // shopify_product_id — so we link via the handle resolved from the Admin API.
  // Falls back to the store home if the handle couldn't be resolved (null token,
  // deleted product, etc.) rather than emitting a guaranteed-404 link.
  const handle = handleMap.get(row.shopify_product_id);
  const url = handle ? `${PRODUCT_BASE}/${handle}` : STORE_HOME;
  return url.slice(0, 5000);
}

// shopify_product_id is a GID ("gid://shopify/Product/7798393897065"); the Admin
// REST product endpoint wants the trailing numeric id.
function gidToNumericId(gid) {
  const m = String(gid || "").match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

// Resolve gid → storefront handle via Shopify Admin API. One GET per DISTINCT
// product (deduped + cached). Lazily imports _shopify-lib so the Shopify token
// is only touched when there are products to resolve. Never throws: an
// unresolvable product maps to null and the description falls back to the home page.
async function resolveHandles(rows) {
  const gids = [...new Set(rows.map((r) => r.shopify_product_id).filter(Boolean))];
  const map = new Map();
  if (!gids.length) return map;
  let rest;
  try {
    ({ rest } = await import("./_shopify-lib.mjs"));
  } catch (e) {
    console.error(`⚠ Shopify lib not loadable (${e.message}); descriptions fall back to ${STORE_HOME}`);
    for (const g of gids) map.set(g, null);
    return map;
  }
  let resolved = 0;
  for (const gid of gids) {
    const numId = gidToNumericId(gid);
    if (!numId) { map.set(gid, null); continue; }
    try {
      const res = await rest(`/products/${numId}.json?fields=id,handle`);
      if (!res.ok) { map.set(gid, null); continue; }
      const data = await res.json();
      const handle = data?.product?.handle || null;
      map.set(gid, handle);
      if (handle) resolved++;
    } catch {
      map.set(gid, null);
    }
    await sleep(120); // gentle on the Admin API (not YouTube quota)
  }
  console.log(`  handles resolved      : ${resolved}/${gids.length} products (rest fall back to ${STORE_HOME})`);
  return map;
}

// --- DB ------------------------------------------------------------------
async function getDb() {
  if (!env.TURSO_DATABASE_URL) {
    console.error("✗ TURSO_DATABASE_URL not found (process.env or .env.local).");
    process.exit(1);
  }
  let createClient;
  try {
    ({ createClient } = await import("@libsql/client"));
  } catch {
    console.error("✗ @libsql/client not resolvable here. Run `bun install` in this worktree.");
    process.exit(1);
  }
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
}

async function fetchCandidates(db) {
  // Idempotent filter: skip rows that already uploaded, unless --force.
  const where = FORCE
    ? "ratio = ?"
    : "ratio = ? AND (youtube_video_id IS NULL OR youtube_video_id = '')";
  const r = await db.execute({
    sql: `SELECT sku, shopify_product_id, title_fr, ratio, duration_sec, blob_url,
                 bytes, youtube_video_id, youtube_status
          FROM video_demand_gen
          WHERE ${where}
          ORDER BY sku ASC, duration_sec ASC`,
    args: [RATIO],
  });
  return r.rows.map((row) => Object.fromEntries(Object.entries(row)));
}

// --- OAuth: refresh_token → access_token --------------------------------
async function getAccessToken() {
  for (const k of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]) {
    if (!env[k]) {
      console.error(`✗ ${k} not found (process.env or .env.local). OAuth2 refresh-token flow is required for videos.insert.`);
      process.exit(1);
    }
  }
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  return json.access_token;
}

// --- resumable upload: init (snippet+status) then PUT bytes --------------
async function uploadOne(accessToken, row, handleMap) {
  // 1) fetch the rendered MP4 from Vercel Blob
  const blobRes = await fetch(row.blob_url);
  if (!blobRes.ok) throw new Error(`blob fetch ${blobRes.status} for ${row.blob_url}`);
  const buf = Buffer.from(await blobRes.arrayBuffer());

  // 2) init resumable session — returns the upload URL in the Location header
  const metadata = {
    snippet: {
      title: videoTitle(row),
      description: videoDescription(row, handleMap),
      categoryId: "22", // People & Blogs (safe default for product demos)
      defaultLanguage: "fr",
      defaultAudioLanguage: "fr",
    },
    status: {
      privacyStatus: PRIVACY,
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(buf.length),
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) {
    const detail = await initRes.text().catch(() => "");
    throw new Error(`resumable init ${initRes.status}: ${detail.slice(0, 300)}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("resumable init returned no Location header");

  // 3) PUT the bytes in a single request (single-shot is fine for these sizes)
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" }, // undici sets Content-Length from the Buffer
    body: buf,
  });
  const putJson = await putRes.json().catch(() => ({}));
  if (!putRes.ok || !putJson.id) {
    const detail = putJson.error?.message || `HTTP ${putRes.status}`;
    throw new Error(`upload PUT failed: ${detail}`);
  }
  return { id: putJson.id, bytes: buf.length };
}

async function recordResult(db, row, { videoId, status }) {
  await db.execute({
    sql: `UPDATE video_demand_gen
          SET youtube_video_id = ?, youtube_status = ?, updated_at = ?
          WHERE sku = ? AND ratio = ? AND duration_sec = ?`,
    args: [videoId, status, Math.floor(Date.now() / 1000), row.sku, RATIO, row.duration_sec],
  });
}

// --- main ----------------------------------------------------------------
const db = await getDb();
const all = await fetchCandidates(db);
const pending = Number.isFinite(LIMIT) ? all.slice(0, LIMIT) : all;

console.log(`YouTube upload — ${APPLY ? "APPLY" : "DRY-RUN"}${FORCE ? " --force" : ""}`);
console.log(`  ratio                 : ${RATIO}`);
console.log(`  candidates (16:9)     : ${all.length}${FORCE ? " (incl. already-uploaded)" : " not yet uploaded"}`);
console.log(`  will process this run : ${pending.length}${Number.isFinite(LIMIT) ? ` (--limit ${LIMIT})` : ""}`);
console.log(`  est. quota cost       : ${pending.length * QUOTA_PER_INSERT} / ${DAILY_QUOTA} units/day  (~${Math.floor(DAILY_QUOTA / QUOTA_PER_INSERT)}/day max)`);
console.log(`  privacyStatus         : ${PRIVACY}`);
console.log("");

if (!pending.length) {
  console.log("Nothing to upload. (All 16:9 rows already have a youtube_video_id — pass --force to re-upload.)");
  process.exit(0);
}

// Resolve storefront handles for the description links (Admin API reads; not YouTube quota).
const handleMap = await resolveHandles(pending);
console.log("");

if (!APPLY) {
  for (const row of pending) {
    console.log(`  would upload  ${row.sku}  ${row.duration_sec}s`);
    console.log(`      title : ${videoTitle(row)}`);
    console.log(`      desc  : ${videoDescription(row, handleMap)}`);
    console.log(`      src   : ${row.blob_url}${row.bytes ? `  (${mb(row.bytes)} MB)` : ""}`);
  }
  if (pending.length * QUOTA_PER_INSERT > DAILY_QUOTA) {
    console.log(`\n  ⚠ ${pending.length} uploads exceed the ${DAILY_QUOTA}-unit daily quota. Use --limit to batch across days.`);
  }
  console.log(`\nDry-run only — reads the DB + Shopify handles, NO upload, NO YouTube quota. Re-run with --apply (checkpoint first — quota is precious).`);
  process.exit(0);
}

// --- APPLY (consumes quota) ---------------------------------------------
// Hard quota guard: refuse to start a run that would exceed the daily quota.
// Escapable ONLY by --limit (an explicit, counted batch) — never by --force,
// which means "re-upload" and must not double as a quota override. If your
// project has a raised quota, edit DAILY_QUOTA above.
if (pending.length * QUOTA_PER_INSERT > DAILY_QUOTA) {
  console.error(`✗ ${pending.length} uploads (~${pending.length * QUOTA_PER_INSERT} units) exceed the ${DAILY_QUOTA}-unit daily quota.`);
  console.error(`  Pass --limit ${Math.floor(DAILY_QUOTA / QUOTA_PER_INSERT)} (or fewer) to batch across days.`);
  process.exit(1);
}

const accessToken = await getAccessToken();
console.log("✓ OAuth access token acquired (refresh_token flow).\n");

let done = 0;
let failed = 0;
const t0 = Date.now();
for (const row of pending) {
  const started = Date.now();
  try {
    const { id, bytes } = await uploadOne(accessToken, row, handleMap);
    await recordResult(db, row, { videoId: id, status: "uploaded" });
    done++;
    console.log(`  ✓ ${row.sku} ${row.duration_sec}s → https://youtu.be/${id}  (${mb(bytes)} MB)`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${row.sku} ${row.duration_sec}s: ${e.message}`);
    // Record the failure (id stays NULL so the row is retried next run).
    try {
      await recordResult(db, row, { videoId: null, status: `error: ${String(e.message).slice(0, 200)}` });
    } catch (e2) {
      console.error(`    (also failed to record error status: ${e2.message})`);
    }
  }
  const elapsed = Date.now() - started;
  if (elapsed < RATE_MS) await sleep(RATE_MS - elapsed);
}

console.log(`\nUploaded ${done}, failed ${failed}, in ${((Date.now() - t0) / 1000).toFixed(0)}s. Quota spent ~${done * QUOTA_PER_INSERT} units.`);
process.exit(failed ? 1 : 0);
