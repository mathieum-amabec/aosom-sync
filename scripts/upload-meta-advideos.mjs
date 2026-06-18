// Push rendered Demand Gen videos into the Meta ad account's video library via
// server-side file_url ingest, and record the resulting video id + status back
// into the Turso `video_demand_gen` table.
//
// Mirrors the TS client (src/lib/meta-ads-client.ts: uploadAdVideo /
// getAdVideoStatus / pollAdVideoReady) but inlines the Graph calls in plain ESM
// so it runs under node x64 with global fetch — no TS loader (same pattern as
// scripts/create-meta-dynamic-ads.mjs).
//
//   node scripts/upload-meta-advideos.mjs                 # DRY-RUN (default): list candidates, upload nothing
//   node scripts/upload-meta-advideos.mjs --apply         # upload each pending asset (PAUSED-safe: advideos only stores the video)
//   node scripts/upload-meta-advideos.mjs --apply --limit 3   # cap the batch (smoke test)
//   node scripts/upload-meta-advideos.mjs --ad-account act_20658834
//
// Selects video_demand_gen rows WHERE meta_video_id IS NULL (and a non-empty
// blob_url). For each: POST /act_<id>/advideos { file_url } → poll GET
// /{video_id}?fields=status until ready/error/timeout → UPDATE meta_video_id +
// meta_status. Idempotent: a recorded meta_video_id is skipped on the next run.
//
// IMPORTANT: talks to the network DB + Meta Graph. On Windows ARM64 run under x64
// node (bun-x64 crashes on network scripts) — see CLAUDE.md "Windows ARM64".
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/upload-meta-advideos.mjs
//
// advideos NEVER spends — it only ingests a video into the library. Attaching it
// to a creative/ad (which can spend) is a separate, later step.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const GRAPH = "https://graph.facebook.com/v18.0"; // matches META.API_VERSION in src/lib/config.ts
const RATE_MS = 500;                              // ≤ 2 Graph requests / sec
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 300_000;                  // 300s, per the brief

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const LIMIT = flag("limit") ? Math.max(0, parseInt(flag("limit"), 10)) : undefined;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const env = loadEnv();
const AD_ACCOUNT = (() => {
  const a = flag("ad-account") || env.META_AD_ACCOUNT_ID || "20658834";
  return a.startsWith("act_") ? a : `act_${a}`;
})();

// ── throttled Graph call (shared 2 req/sec gate across uploads + polls) ──────
let lastCall = 0;
async function gate() {
  const wait = RATE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function graph(path, { method = "GET", body, params = {} } = {}) {
  await gate();
  const url = new URL(`${GRAPH}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", env.META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const init = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), init);
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`Meta API: ${data.error.error_user_msg || data.error.message}${data.error.code ? ` (code ${data.error.code})` : ""}`);
  }
  if (!res.ok) throw new Error(`Meta API HTTP ${res.status} on ${path}`);
  return data;
}

async function uploadAdVideo(fileUrl, name) {
  const body = { file_url: fileUrl };
  if (name) body.name = name;
  return graph(`${AD_ACCOUNT}/advideos`, { method: "POST", body });
}

async function pollAdVideoReady(videoId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await graph(videoId, { params: { fields: "status" } });
    const vs = res.status?.video_status;
    if (vs === "ready") return "ready";
    if (vs === "error") throw new Error(`processing failed: ${JSON.stringify(res.status ?? {})}`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`not ready after ${Math.round(POLL_TIMEOUT_MS / 1000)}s (status: ${vs ?? "unknown"})`);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

// ── DB ───────────────────────────────────────────────────────────────────
if (!env.TURSO_DATABASE_URL) fail("TURSO_DATABASE_URL not found in .env.local");
const { createClient } = await import("@libsql/client");
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const sel = await db.execute(
  `SELECT id, sku, ratio, duration_sec, title_fr, blob_url
     FROM video_demand_gen
    WHERE meta_video_id IS NULL
      AND blob_url IS NOT NULL AND blob_url != ''
    ORDER BY sku, ratio, duration_sec`,
);
let pending = sel.rows;
if (LIMIT != null) pending = pending.slice(0, LIMIT);

console.log(`Meta advideos upload — ${APPLY ? "APPLY" : "DRY-RUN"}   ad account: ${AD_ACCOUNT}`);
console.log(`  pending (meta_video_id IS NULL): ${sel.rows.length}${LIMIT != null ? `  → capped to ${pending.length} via --limit` : ""}`);
console.log(`  est. time @2 req/s             : ~${pending.length}s+ (≥1 upload + ≥1 poll each, 500ms apart)\n`);

for (const r of pending) {
  console.log(`  ${APPLY ? "upload" : "would upload"}  #${r.id} ${r.sku} ${r.ratio} ${r.duration_sec}s  →  ${r.blob_url}`);
}

if (!APPLY) {
  console.log(`\n── DRY RUN — nothing uploaded, DB untouched. ──`);
  console.log(`Re-run with --apply to ingest into Meta (checkpoint before this).`);
  await db.close?.();
  process.exit(0);
}

// ── APPLY ──────────────────────────────────────────────────────────────────
if (!env.META_ACCESS_TOKEN) fail("META_ACCESS_TOKEN not found in .env.local");
if (!pending.length) {
  console.log("\nNothing to upload — every asset already has a meta_video_id.");
  await db.close?.();
  process.exit(0);
}

async function recordStatus(id, videoId, status) {
  await db.execute({
    sql: `UPDATE video_demand_gen SET meta_video_id = ?, meta_status = ?, updated_at = ? WHERE id = ?`,
    args: [videoId, status, Math.floor(Date.now() / 1000), id],
  });
}

let done = 0;
let failed = 0;
const t0 = Date.now();
for (const r of pending) {
  try {
    const { id: videoId } = await uploadAdVideo(r.blob_url, r.title_fr || `${r.sku} ${r.ratio} ${r.duration_sec}s`);
    if (!videoId) throw new Error("advideos returned no video id");
    let status;
    try {
      status = await pollAdVideoReady(videoId); // "ready" or throws
    } catch (pollErr) {
      // We have a real video id but it failed/timed out processing — persist BOTH so
      // the row isn't retried as fresh, and the failure is visible in meta_status.
      await recordStatus(r.id, videoId, "error");
      failed++;
      console.error(`  ✗ #${r.id} ${r.sku}: video ${videoId} ${pollErr.message} (recorded meta_status=error)`);
      continue;
    }
    await recordStatus(r.id, videoId, status);
    done++;
    console.log(`  ✓ #${r.id} ${r.sku} ${r.ratio} ${r.duration_sec}s → video ${videoId} (${status})`);
  } catch (uploadErr) {
    // Upload itself failed: no video id, so leave meta_video_id NULL (retried next run).
    failed++;
    console.error(`  ✗ #${r.id} ${r.sku}: ${uploadErr.message}`);
  }
}

await db.close?.();
console.log(`\nUploaded ${done}, failed ${failed}, of ${pending.length} attempted, in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
process.exit(failed ? 1 : 0);
