#!/usr/bin/env tsx
/**
 * scripts/sold-out-hide.mts — operator run of the sold-out / out-of-season hide (src/lib/sold-out-hide.ts),
 * the same code the cron /api/cron/sold-out-hide runs.
 *
 * Dry run by default. Always writes the plan (SKUs, title, reason, current status, tags before/after) as a
 * rollback record to <out>/soldout-<date>[-applied].json before anything else.
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/sold-out-hide.mts \
 *     [--out C:/Users/vente/Documents/aosom-sync-backups] [--max 150] [--apply]
 *
 * Rollback for one product: PUT /products/<id>.json {product:{id, status:<currentStatus>, tags:<previousTags>}}
 * (+ published:true for one that was active). Remove `auto-drafted` / `hors-saison` or the job re-applies it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const OUT = flag("--out") ?? "C:/Users/vente/Documents/aosom-sync-backups";
const MAX = flag("--max") ? Number(flag("--max")) : undefined;

async function main() {
  const { runSoldOutHide } = await import("@/lib/sold-out-hide-run");
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(OUT, { recursive: true });

  const dry = await runSoldOutHide({ mode: "dry" });
  const record = (r: typeof dry) => r.actions.map((a) => ({
    shopifyProductId: a.shopifyProductId, skus: a.skus, title: a.title, handle: a.handle, source: a.source,
    action: a.action, reason: a.reason, currentStatus: a.currentStatus, targetStatus: a.targetStatus,
    previousTags: a.previousTags, newTags: a.tags,
  }));
  const dryFile = join(OUT, `soldout-${date}.json`);
  writeFileSync(dryFile, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "dry", counts: dry.counts, actions: record(dry) }, null, 2));
  console.log(`\nsold-out-hide — DRY plan written to ${dryFile}`);
  console.log(JSON.stringify(dry.counts, null, 2));
  const by: Record<string, number> = {};
  for (const a of dry.actions) by[`${a.action}/${a.source}`] = (by[`${a.action}/${a.source}`] ?? 0) + 1;
  console.log(by);

  if (!APPLY) { console.log("\nDry run only — pass --apply to write."); return; }

  const live = await runSoldOutHide({ mode: "live", maxWrites: MAX });
  const liveFile = join(OUT, `soldout-${date}-applied.json`);
  writeFileSync(liveFile, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "live", counts: live.counts,
    applied: live.applied, skippedChanged: live.skippedChanged, deferred: live.deferred, failed: live.failed, actions: record(live) }, null, 2));
  console.log(`\nAPPLIED: applied=${live.applied} skippedChanged=${live.skippedChanged} deferred=${live.deferred} failed=${live.failed}`);
  console.log(`record: ${liveFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
