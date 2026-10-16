// Mirror customer unboxing videos (homepage reel) from the supplier CDN to OUR public
// Vercel Blob store, so the storefront never hotlinks the supplier.
//
//   node --env-file=.env.local scripts/mirror-ugc-videos.mjs           # DRY-RUN (read-only)
//   node --env-file=.env.local scripts/mirror-ugc-videos.mjs --apply   # copy + update manifest
//   ... --limit 60                                                     # pool size (default 60)
//
// Reads the same candidates as getUgcVideoCandidates (src/lib/database.ts), most in
// stock first. Each video goes to ugc-videos/<CA|US>/<file>.mp4 (no random suffix, so
// the URL is deterministic — see src/lib/ugc-video-mirror.ts) and the mirrored paths
// are listed in ugc-videos/manifest.json, which the reel reads. Idempotent: paths
// already in the manifest are skipped; the manifest is rewritten after every upload.
// Needs the PUBLIC blob token (vercel_blob_rw_jcSkqp8…), see CLAUDE.md.

import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const LIMIT = li > -1 ? Number(process.argv[li + 1]) : 60;
const BASE = (process.env.UGC_VIDEO_BASE_URL || "https://jcskqp8orcub9i0l.public.blob.vercel-storage.com").replace(/\/+$/, "");
const MANIFEST = "ugc-videos/manifest.json";
const MAX_BYTES = 40 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pathFor = (src) => {
  const m = String(src).match(/\/customer\/(CA|US)\/([A-Za-z0-9._-]+\.mp4)(?:[?#].*)?$/i);
  return m ? `ugc-videos/${m[1].toUpperCase()}/${m[2]}` : null;
};

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = (await db.execute({
  sql: `SELECT sku, qty, video_ugc FROM products
        WHERE video_ugc IS NOT NULL AND TRIM(video_ugc) <> '' AND qty > 0
          AND shopify_handle IS NOT NULL AND TRIM(shopify_handle) <> ''
          AND (video_ugc LIKE '%/customer/CA/%' OR video_ugc LIKE '%/customer/US/%')
        ORDER BY qty DESC LIMIT ?`,
  args: [LIMIT],
})).rows;

let manifest = { paths: [] };
try {
  const r = await fetch(`${BASE}/${MANIFEST}?t=${Date.now()}`);
  if (r.ok) manifest = await r.json();
} catch { /* first run */ }
const have = new Set(manifest.paths || []);

const todo = [];
for (const r of rows) {
  const p = pathFor(r.video_ugc);
  if (!p) { console.log("skip (unrecognised URL)", r.sku); continue; }
  if (have.has(p) || todo.some((t) => t.path === p)) continue;
  todo.push({ sku: String(r.sku), src: String(r.video_ugc), path: p });
}
console.log(`candidates ${rows.length}, already mirrored ${have.size}, to mirror ${todo.length}`);
for (const t of todo.slice(0, 5)) console.log("  ", t.sku, "→", `${BASE}/${t.path}`);
if (!APPLY) { console.log("DRY RUN — re-run with --apply"); process.exit(0); }

const { put } = await import("@vercel/blob");
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token?.startsWith("vercel_blob_rw_jcSkqp8")) throw new Error("BLOB_READ_WRITE_TOKEN is not the PUBLIC store token (see CLAUDE.md)");

let ok = 0, failed = 0;
for (const t of todo) {
  try {
    const res = await fetch(t.src);
    if (!res.ok) throw new Error(`source ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`too large ${buf.length}`);
    await put(t.path, buf, { access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true, token, cacheControlMaxAge: 31536000 });
    have.add(t.path);
    await put(MANIFEST, JSON.stringify({ paths: [...have].sort(), updatedAt: new Date().toISOString() }), { access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, token, cacheControlMaxAge: 300 });
    ok++;
    console.log("ok", t.sku, (buf.length / 1048576).toFixed(1) + " MB");
  } catch (e) {
    failed++;
    console.log("FAIL", t.sku, String(e).slice(0, 120));
  }
  await sleep(500);
}
console.log(`done: ${ok} mirrored, ${failed} failed, manifest has ${have.size}`);
