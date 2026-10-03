#!/usr/bin/env tsx
/**
 * scripts/rerender-stale-sequential-ads.mts — re-render, in place, every sequential-ad DRAFT
 * whose burned price is stale (price guard, src/lib/sequential-ad-price.ts).
 *
 * A draft is stale when the approval / publisher guard flagged it (metadata.needsRerender), or
 * when its recorded metadata.renderedPrice no longer equals today's catalogue price. Drafts are
 * grouped by creative (style) and campaign, and each group is re-rendered with
 * render-sequential-ads.mts `--skus … --replace`, which keeps the id, the slot and the status
 * and records the new price. Dry-run by default (prints the plan); --apply runs the renders.
 *
 * The music + source clips are gitignored and live in the MAIN clone. Run from there, or from
 * a worktree with SEQ_ASSETS_ROOT=<main clone> (sets SEQ_MUSIC / SEQ_CLIP_DIR per group):
 *   FFMPEG_BIN="…/ffmpeg.exe" node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/rerender-stale-sequential-ads.mts [--apply]
 */
import path from "path";
import { spawnSync } from "child_process";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

const STYLE_ARGS: Record<string, string[]> = {
  hero_slides: ["--style", "hero"],
  demand_gen_messages: ["--style", "demand-gen"],
  ugc_video: ["--style", "demand-gen", "--ugc"],
};

const rows = (
  await db.execute(
    `SELECT id, content_id, metadata FROM publication_queue WHERE content_type = 'sequential_ad' AND status = 'draft'`,
  )
).rows;
// content_id is "seqad:<style>:<campaign>:<sku>"
const skuOf = (contentId: string) => contentId.split(":").slice(3).join(":");
const skus = [...new Set(rows.map((r) => skuOf(String(r.content_id))).filter(Boolean))];
const priceBySku = new Map<string, number>();
for (let i = 0; i < skus.length; i += 200) {
  const chunk = skus.slice(i, i + 200);
  const pr = await db.execute({ sql: `SELECT sku, price FROM products WHERE sku IN (${chunk.map(() => "?").join(",")})`, args: chunk });
  for (const x of pr.rows) priceBySku.set(String(x.sku), Number(x.price));
}

type Group = { style: string; campaign: string; skus: string[] };
const groups = new Map<string, Group>();
let stale = 0;
for (const r of rows) {
  const contentId = String(r.content_id);
  const [, style, campaign, ...rest] = contentId.split(":");
  const sku = rest.join(":");
  let meta: Record<string, unknown> = {};
  try { meta = r.metadata ? JSON.parse(String(r.metadata)) : {}; } catch { /* legacy row */ }
  const rendered = typeof meta.renderedPrice === "number" ? meta.renderedPrice : null;
  const current = priceBySku.get(sku) ?? null;
  const flagged = meta.needsRerender === true;
  const drifted = rendered != null && current != null && Math.abs(rendered - current) >= 0.005;
  if (!flagged && !drifted) continue;
  if (!STYLE_ARGS[style]) { console.log(`  ? ${contentId}: unknown style, skipped`); continue; }
  stale++;
  const key = `${style}|${campaign}`;
  const g = groups.get(key) ?? { style, campaign, skus: [] };
  g.skus.push(sku);
  groups.set(key, g);
  console.log(`  #${r.id} ${sku.padEnd(14)} ${campaign.padEnd(16)} ${rendered ?? "?"} → ${current ?? "?"}${flagged ? "  (flagged)" : ""}`);
}
console.log(`\n${stale} stale draft(s) of ${rows.length}, ${groups.size} render group(s).`);

const renderer = path.resolve("scripts/render-sequential-ads.mts");
const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
for (const g of groups.values()) {
  const args = [tsx, renderer, ...STYLE_ARGS[g.style], "--campaign", g.campaign, "--skus", g.skus.join(","), "--replace", "--apply"];
  console.log(`\n▶ ${g.style} / ${g.campaign} — ${g.skus.length} ad(s)`);
  if (!APPLY) { console.log(`  (dry-run) node ${args.slice(1).join(" ")}`); continue; }
  const env = { ...process.env };
  const assets = process.env.SEQ_ASSETS_ROOT;
  if (assets) {
    env.SEQ_MUSIC = path.join(assets, "src/audio/sigmamusicart-no-copyright-music-514564.mp3");
    env.SEQ_CLIP_DIR = path.join(assets, g.style === "ugc_video" ? "src/ugc" : "src");
  }
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (r.status !== 0) console.log(`  ✗ group failed (exit ${r.status}) — re-run to retry the rest`);
}
if (!APPLY && stale) console.log("\nDry-run. Re-run with --apply to re-render.");
