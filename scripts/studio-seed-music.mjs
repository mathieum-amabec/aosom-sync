#!/usr/bin/env node
/**
 * Upload the local music library (src/audio/*.mp3 — gitignored, never deployed) to the PUBLIC
 * Blob store under studio/music/, so the Studio Avant/Après renderer on Vercel can use it.
 *
 * Retired tracks (src/lib/music-retired.ts) are skipped. Existing files are left alone unless
 * --force. Dry run by default.
 *
 * Needs the PUBLIC store token (see CLAUDE.md "Demand-gen uploads need a PUBLIC Blob store"):
 *   node --env-file=.env.local scripts/studio-seed-music.mjs [--apply] [--force]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { put, list } from "@vercel/blob";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const DIR = "src/audio";
const PREFIX = "studio/music/";
const RETIRED = new Set(["mixkit-corporate-22.mp3"]);

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN missing (run with --env-file=.env.local)");
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".mp3") && !RETIRED.has(f));
const existing = new Set((await list({ prefix: PREFIX, limit: 1000 })).blobs.map((b) => b.pathname));
console.log(`${files.length} local tracks, ${existing.size} already in ${PREFIX} — ${APPLY ? "APPLY" : "DRY-RUN"}`);
for (const f of files) {
  const target = PREFIX + f;
  if (existing.has(target) && !FORCE) {
    console.log(`  = ${f} (already uploaded)`);
    continue;
  }
  if (!APPLY) {
    console.log(`  + ${f} (would upload)`);
    continue;
  }
  const { url } = await put(target, readFileSync(path.join(DIR, f)), {
    access: "public",
    contentType: "audio/mpeg",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  console.log(`  ✓ ${f} → ${url}`);
}
