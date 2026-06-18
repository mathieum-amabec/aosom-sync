// Demand Gen asset uploader — pushes the rendered MP4s to Vercel Blob and records
// the public URLs back into out/demand-gen-manifest.json.
//
// Plain ESM (.mjs) so it runs under node x64 with global fetch — no TS loader needed
// (mirrors scripts/_shopify-lib.mjs).
//
//   node scripts/upload-demand-gen.mjs            # DRY-RUN (default) — no network, no deps
//   node scripts/upload-demand-gen.mjs --apply    # real upload (needs @vercel/blob + BLOB_READ_WRITE_TOKEN)
//   node scripts/upload-demand-gen.mjs --apply --force   # re-upload assets already recorded
//
// Run from the clone/worktree root that holds out/demand-gen/ (where T4 renders).
// - DRY-RUN lists exactly what would upload; safe to run anywhere, needs nothing.
// - Rate-limited to 2 uploads/sec.
// - Idempotent: assets already carrying a blob_url in the manifest are skipped, and
//   the manifest is rewritten after every upload — a re-run resumes where it stopped.
//
// Blob layout: demand-gen/{sku}/{file}.mp4 → stable public URL (no random suffix).

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const MANIFEST = join(ROOT, "out", "demand-gen-manifest.json");
const ASSET_DIR = join(ROOT, "out", "demand-gen");
const BLOB_PREFIX = "demand-gen"; // blob pathname: demand-gen/{sku}/{file}
const RATE_MS = 500; // ≤ 2 uploads / sec

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => (bytes / 1048576).toFixed(2);

// --- env (only needed for --apply) --------------------------------------
function loadToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(ROOT, ".env.local"), join(here, "..", ".env.local")];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^BLOB_READ_WRITE_TOKEN=(.*)$/);
      if (!m) continue;
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return null;
}

// --- discover rendered assets (on-disk is the source of truth) ----------
function findAssets() {
  if (!existsSync(ASSET_DIR)) return [];
  const out = [];
  for (const sku of readdirSync(ASSET_DIR)) {
    const skuDir = join(ASSET_DIR, sku);
    let st;
    try {
      st = statSync(skuDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(skuDir)) {
      if (!f.endsWith(".mp4")) continue;
      const abs = join(skuDir, f);
      out.push({
        sku,
        file: f,
        rel: `out/demand-gen/${sku}/${f}`,
        abs,
        bytes: statSync(abs).size,
        blobPath: `${BLOB_PREFIX}/${sku}/${f}`,
      });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    console.error(`✗ Manifest parse error (${MANIFEST}): ${e.message}`);
    process.exit(1);
  }
}

// uploads are recorded as a dedicated top-level array keyed by rel path — this is
// additive and does not touch T4's videos[] schema.
function uploadedUrlFor(manifest, rel) {
  return (manifest?.uploads || []).find((u) => u.file === rel)?.blob_url || null;
}

// Merge one upload record into the on-disk manifest atomically. The manifest is
// RE-READ from disk every time (not the startup snapshot) so concurrent renderer
// (T4) updates to videos[]/summary survive — we only ever touch `uploads` and
// `summary.uploaded`. Write goes to a temp file then rename() so an interrupt
// leaves either the old or new complete file, never a truncated one.
function persistUpload(asset, url) {
  const fresh = loadManifest() || { uploads: [] };
  if (!Array.isArray(fresh.uploads)) fresh.uploads = [];
  const entry = {
    sku: asset.sku,
    file: asset.rel,
    bytes: asset.bytes,
    blob_path: asset.blobPath,
    blob_url: url,
  };
  const i = fresh.uploads.findIndex((u) => u.file === asset.rel);
  if (i >= 0) fresh.uploads[i] = { ...fresh.uploads[i], ...entry };
  else fresh.uploads.push(entry);
  if (fresh.summary) fresh.summary.uploaded = fresh.uploads.length;
  const tmp = `${MANIFEST}.tmp`;
  writeFileSync(tmp, JSON.stringify(fresh, null, 2));
  renameSync(tmp, MANIFEST);
}

// --- main ---------------------------------------------------------------
const assets = findAssets();
const manifest = loadManifest();

if (!assets.length) {
  console.error(`✗ No .mp4 assets under ${ASSET_DIR}. Run from the root that holds out/demand-gen/ (has T4 finished rendering?).`);
  process.exit(1);
}
if (!manifest) {
  console.error(`${APPLY ? "✗" : "⚠"}  ${MANIFEST} not found.`);
  if (APPLY) process.exit(1); // --apply must be able to record URLs back
}

const expected = manifest?.summary?.total_output_assets;
const pending = assets.filter((a) => FORCE || !uploadedUrlFor(manifest, a.rel));
const skipped = assets.length - pending.length;
const totalBytes = pending.reduce((s, a) => s + a.bytes, 0);

console.log(`Demand Gen upload — ${APPLY ? "APPLY" : "DRY-RUN"}${FORCE ? " --force" : ""}`);
console.log(`  assets on disk        : ${assets.length}${expected ? ` (manifest expects ${expected})` : ""}`);
console.log(`  already uploaded (skip): ${skipped}`);
console.log(`  to upload             : ${pending.length}  (${mb(totalBytes)} MB)`);
console.log(`  est. time @2/s        : ~${Math.ceil(pending.length / 2)}s`);
if (expected && assets.length !== expected) {
  console.log(`  ⚠ disk count ${assets.length} ≠ manifest total_output_assets ${expected} — rendering may be incomplete.`);
}
console.log("");

if (!APPLY) {
  for (const a of pending) {
    console.log(`  would upload  ${a.rel}  →  blob:${a.blobPath}  (${mb(a.bytes)} MB)`);
  }
  console.log(`\nDry-run only. Re-run with --apply to upload (checkpoint before this).`);
  process.exit(0);
}

// --- APPLY ---------------------------------------------------------------
// Refuse a partially-rendered set: uploading mid-render would push half the
// assets, and (more importantly) it keeps --apply from running while T4's
// renderer is still rewriting the manifest. Wait for rendering to finish, or
// pass --force to override.
if (expected && assets.length !== expected && !FORCE) {
  console.error(`✗ Only ${assets.length}/${expected} assets rendered — wait for rendering to finish, or pass --force.`);
  process.exit(1);
}

// Guard against two source files mapping to the same blob key (addRandomSuffix
// is off + allowOverwrite is on, so a collision would silently clobber).
const byBlobPath = new Map();
for (const a of pending) {
  const prev = byBlobPath.get(a.blobPath);
  if (prev) {
    console.error(`✗ Blob path collision: ${a.rel} and ${prev} both map to ${a.blobPath}`);
    process.exit(1);
  }
  byBlobPath.set(a.blobPath, a.rel);
}

const token = loadToken();
if (!token) {
  console.error("✗ BLOB_READ_WRITE_TOKEN not found (process.env or .env.local).");
  process.exit(1);
}
let put;
try {
  ({ put } = await import("@vercel/blob"));
} catch {
  console.error("✗ @vercel/blob not resolvable here. Run `bun install` in this worktree, or run from a clone with deps installed.");
  process.exit(1);
}

let done = 0;
let failed = 0;
const t0 = Date.now();
for (const a of pending) {
  const started = Date.now();
  let url = null;
  // 1) upload — only an upload error counts as a failed asset
  try {
    const buf = readFileSync(a.abs);
    a.bytes = buf.length; // record the size actually uploaded, not the scan-time size
    const blob = await put(a.blobPath, buf, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });
    url = blob.url;
  } catch (e) {
    failed++;
    console.error(`  ✗ ${a.rel}: ${e.message}`);
  }
  // 2) persist — separate from upload so a write failure is reported as such
  if (url) {
    try {
      persistUpload(a, url); // re-read + atomic merge → resumable, race-safe
      done++;
      console.log(`  ✓ ${a.rel} → ${url}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${a.rel}: uploaded to ${url} but manifest write failed: ${e.message}`);
    }
  }
  const elapsed = Date.now() - started;
  if (elapsed < RATE_MS) await sleep(RATE_MS - elapsed);
}

const recorded = (loadManifest()?.uploads || []).length;
console.log(`\nUploaded ${done}, failed ${failed}, recorded ${recorded} total, in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
process.exit(failed ? 1 : 0);
